// Real Pi loader, Hunk, Neovim, git repository and a disposable tmux server; never the user's tmux server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, realpathSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const socketName = `pi-diff-test-${process.pid}`;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'diff-pane-')));
const repo = join(dir, 'repo');
const tmux = (...args) => execFileSync('tmux', ['-L', socketName, ...args], { encoding: 'utf8' }).trim();
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe', env: { ...process.env,
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.test' } });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const panes = (tag = '@pi_diff_owner') => tmux('list-panes', '-a', '-F', `#{pane_id} #{${tag}}`).split('\n').map(row => row.split(' '));
const diffPanes = owner => panes().filter(([, tag]) => tag === owner).map(([id]) => id);
const docPanes = owner => panes('@pi_doc_owner').filter(([, tag]) => tag === owner).map(([id]) => id);
const screen = pane => tmux('capture-pane', '-p', '-t', pane);
async function screenContains(pane, text) {
  for (let i = 0; i < 50; i++) {
    if (tmux('capture-pane', '-p', '-t', pane).includes(text)) return true;
    await sleep(100);
  }
  return false;
}

const previous = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
// Each test Pi in the terminal UI listens for SIGHUP and SIGTERM, as Pi would; removed after the tests.
const signals = Object.fromEntries(['SIGHUP', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
let owner, extension, context, notices = [];
let calls = 0;
const fire = async (name, event, ctx = context, ext = extension) => {
  for (const handler of ext.handlers.get(name) ?? []) await handler(event, ctx);
};
// One tool call as its own turn.
async function tool(toolName, change, ctx = context, ext = extension, input = {}) {
  const event = { toolCallId: `call-${++calls}`, toolName, input };
  await fire('tool_call', event, ctx, ext);
  change?.();
  await fire('tool_result', { ...event, content: [] }, ctx, ext);
  await fire('turn_end', {}, ctx, ext);
}
async function load() {
  const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const { loadExtensions } = await import(pathToFileURL(join(modules, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
  const result = await loadExtensions([join(root, 'pi/extensions/diff-pane.ts')], root);
  assert.deepEqual(result.errors, []);
  return result.extensions[0];
}

test.before(async () => {
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'tracked.txt'), 'one\n');
  writeFileSync(join(repo, 'dirty.txt'), 'old\n');
  git('add', '.'); git('commit', '-qm', 'baseline');
  appendFileSync(join(repo, 'dirty.txt'), 'pre-existing user change\n');
  // Neovim swap files and state stay in the temporary directory; the pinned renderer is read from the real data home.
  process.env.XDG_STATE_HOME = join(dir, 'state');
  tmux('new-session', '-d', '-s', 'test', '-x', '240', '-y', '50', '-c', repo);
  owner = tmux('display-message', '-p', '-t', 'test', '#{pane_id}');
  process.env.TMUX = `${tmux('display-message', '-p', '#{socket_path}')},0,0`;
  process.env.TMUX_PANE = owner;
  // Guard: plain `tmux` must now address the disposable server.
  assert.equal(execFileSync('tmux', ['display-message', '-p', '#{socket_path}'], { encoding: 'utf8' }).trim(),
    tmux('display-message', '-p', '#{socket_path}'));
  extension = await load();
  context = { mode: 'tui', cwd: repo, hasUI: true, ui: { notify: text => notices.push(text) } };
  await fire('session_start', {});
  await fire('before_agent_start', {});
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

test('pre-existing changes and read-only tools do not open a pane', async () => {
  await tool('read');
  await tool('bash');
  await tool('read', () => appendFileSync(join(repo, 'tracked.txt'), 'changed during read\n'));
  git('checkout', 'tracked.txt');
  // Staging an existing change or touching an untracked file changes status or timestamps, not what Hunk shows.
  writeFileSync(join(repo, 'scratch.txt'), 'user scratch\n');
  await tool('bash', () => git('add', 'dirty.txt'));
  await tool('bash', () => utimesSync(join(repo, 'scratch.txt'), new Date(), new Date(Date.now() + 5000)));
  await tool('bash', () => git('reset', '-q', 'dirty.txt'));
  await tool('bash', () => git('add', 'scratch.txt'));
  git('rm', '-q', '--cached', 'scratch.txt');
  rmSync(join(repo, 'scratch.txt'));
  assert.deepEqual(diffPanes(owner), []);
});

test('a parallel batch whose files end where they started opens nothing', async () => {
  // Pi runs every tool_call handler before executing a parallel batch; a fast call's result can arrive mid-way.
  const fast = { toolCallId: `call-${++calls}`, toolName: 'bash', input: {} };
  const slow = { toolCallId: `call-${++calls}`, toolName: 'bash', input: {} };
  await fire('tool_call', fast); await fire('tool_call', slow);
  appendFileSync(join(repo, 'tracked.txt'), 'transient\n');
  await fire('tool_result', { ...fast, content: [] });
  git('checkout', 'tracked.txt');
  await fire('tool_result', { ...slow, content: [] });
  await fire('turn_end', {});
  assert.deepEqual(diffPanes(owner), []);
});

test('moving HEAD without editing files opens nothing', async () => {
  writeFileSync(join(repo, 'later.txt'), 'later\n'); git('add', 'later.txt'); git('commit', '-qm', 'later');
  await tool('bash', () => git('reset', '-q', '--soft', 'HEAD~1'));
  git('reset', '-q', 'later.txt'); rmSync(join(repo, 'later.txt'));
  assert.deepEqual(diffPanes(owner), []);
});

test('outside the terminal UI nothing opens', async () => {
  await tool('edit', () => writeFileSync(join(repo, 'rpc.txt'), 'rpc\n'), { ...context, mode: 'rpc' });
  rmSync(join(repo, 'rpc.txt'));
  assert.deepEqual(diffPanes(owner), []);
});

test('a new change opens one Hunk pane beside Pi, keeps focus and refreshes', async () => {
  await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'agent edit\n'));
  const [pane] = diffPanes(owner);
  assert.ok(pane, 'diff pane opened');
  assert.equal(tmux('display-message', '-p', '-t', owner, '#{pane_active}'), '1', 'Pi keeps focus');
  assert.equal(tmux('display-message', '-p', '-t', pane, '#{window_id}'), tmux('display-message', '-p', '-t', owner, '#{window_id}'));
  assert.ok(await screenContains(pane, 'agent edit'), 'shows the edit');
  assert.ok(await screenContains(pane, 'pre-existing user change'), 'shows the whole working diff, not only agent changes');
  // Live refresh without any tool event; staged and untracked files both appear.
  writeFileSync(join(repo, 'staged.txt'), 'staged\n'); git('add', 'staged.txt');
  writeFileSync(join(repo, 'untracked.txt'), 'untracked\n');
  assert.ok(await screenContains(pane, 'staged.txt'), 'staged file appears');
  assert.ok(await screenContains(pane, 'untracked.txt'), 'untracked file appears');
  await tool('bash', () => writeFileSync(join(repo, 'bash.txt'), 'bash\n'));
  await tool('write', () => writeFileSync(join(repo, 'write.txt'), 'write\n'));
  assert.deepEqual(diffPanes(owner), [pane], 'no duplicate pane');
});

test('closing the pane is respected until the next prompt', async () => {
  const [pane] = diffPanes(owner);
  tmux('send-keys', '-t', pane, 'q');
  for (let i = 0; i < 30 && diffPanes(owner).length; i++) await sleep(100);
  assert.deepEqual(diffPanes(owner), [], 'q closes Hunk and its pane');
  await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'after dismissal\n'));
  assert.deepEqual(diffPanes(owner), []);
  await fire('before_agent_start', {});
  await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'next prompt\n'));
  assert.equal(diffPanes(owner).length, 1);
});

test('reload keeps and adopts the pane; quit closes only this owner\'s pane', async () => {
  const [pane] = diffPanes(owner);
  const unrelated = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', owner);
  const other = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', owner);
  const othersDiff = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', owner);
  tmux('set-option', '-p', '-t', othersDiff, '@pi_diff_owner', other);
  const orphan = tmux('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', owner);
  tmux('set-option', '-p', '-t', orphan, '@pi_diff_owner', '%99999');

  await fire('session_shutdown', { reason: 'reload' });
  assert.deepEqual(diffPanes(owner), [pane]);
  const reloaded = await load();
  await fire('session_start', {}, context, reloaded);
  await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'after reload\n'), context, reloaded);
  assert.deepEqual(diffPanes(owner), [pane], 'adopted, not duplicated');
  assert.ok(panes().some(([id]) => id === orphan), 'another owner’s abandoned pane is left alone');

  await fire('session_shutdown', { reason: 'quit' }, { ...context, mode: 'rpc' }, reloaded);
  assert.deepEqual(diffPanes(owner), [pane], 'a child Pi process inheriting TMUX_PANE does not close it');
  await fire('session_shutdown', { reason: 'quit' }, context, reloaded);
  const left = panes().map(([id]) => id);
  assert.deepEqual(diffPanes(owner), []);
  for (const id of [owner, unrelated, other, othersDiff, orphan]) assert.ok(left.includes(id), `${id} preserved`);
  await fire('session_shutdown', { reason: 'quit' }, context, reloaded);  // idempotent
});

test('a change that leaves a clean tree does not open a pane', async () => {
  await fire('before_agent_start', {});
  await tool('bash', () => { git('add', '-A'); git('commit', '-qm', 'all'); });
  assert.deepEqual(diffPanes(owner), []);
  assert.deepEqual(notices, []);
});

// A check that throws (e.g. reading a file mid-save) counts as not yet.
async function waitFor(check, message) {
  for (let i = 0; i < 50; i++) { try { if (check()) return; } catch {} await sleep(100); }
  assert.fail(message);
}
const notes = join(repo, 'notes.md');
const guide = join(repo, 'guide.md');
const disk = file => readFileSync(file, 'utf8');

test('a Markdown change opens one rendered, editable Neovim beside Pi and follows clean changes', async () => {
  for (const [id] of panes()) if (id !== owner) tmux('kill-pane', '-t', id);  // panes left by the ownership test
  await fire('before_agent_start', {});
  await tool('write', () => writeFileSync(notes, '# Notes\n\n- [ ] agent task\n'));
  assert.deepEqual(diffPanes(owner), [], 'Markdown alone does not open Hunk');
  const [doc] = docPanes(owner);
  assert.ok(doc, 'editor opened');
  assert.equal(tmux('display-message', '-p', '-t', owner, '#{pane_active}'), '1', 'Pi keeps focus');
  assert.equal(tmux('display-message', '-p', '-t', doc, '#{window_id}'), tmux('display-message', '-p', '-t', owner, '#{window_id}'));
  assert.ok(await screenContains(doc, 'agent task'));
  assert.match(screen(doc), /☐ +agent task/, 'the task checkbox is rendered');
  tmux('send-keys', '-t', doc, 'G', 'o', 'user line', 'Escape', ':w', 'Enter');
  await waitFor(() => disk(notes).includes('user line'), 'the editor saves the user edit');
  await tool('edit', () => appendFileSync(notes, 'agent second\n'));
  assert.ok(await screenContains(doc, 'agent second'), 'a clean buffer reloads the agent change');
  await tool('write', () => writeFileSync(guide, '# Guide\n\nagent guide\n'));
  assert.ok(await screenContains(doc, 'agent guide'), 'a clean editor switches to the newly changed document');
  assert.deepEqual(docPanes(owner), [doc], 'no second editor');
});

test('unsaved edits survive other documents, agent writes and Pi quit', async () => {
  const [doc] = docPanes(owner);
  tmux('send-keys', '-t', doc, 'G', 'o', 'unsaved user line', 'Escape');
  assert.ok(await screenContains(doc, 'unsaved user line'));
  await tool('write', () => writeFileSync(notes, '# Notes again\n'));
  assert.ok(await screenContains(doc, 'Also requested: notes.md'), 'the editor stays on the modified document and says so');
  assert.ok(screen(doc).includes('unsaved user line'));
  await tool('edit', () => appendFileSync(guide, 'agent conflicting line\n'));
  assert.ok(await screenContains(doc, 'Changed on disk; edits kept'), 'the conflict is explicit');
  assert.ok(screen(doc).includes('unsaved user line') && !screen(doc).includes('agent conflicting line'), 'the buffer is not reloaded');
  assert.ok(disk(guide).includes('agent conflicting line') && !disk(guide).includes('unsaved user line'), 'the agent write is on disk');
  tmux('send-keys', '-t', doc, ':w', 'Enter');
  assert.ok(await screenContains(doc, 'changed since reading it'), 'Neovim asks before overwriting');
  tmux('send-keys', '-t', doc, 'n', 'Enter');
  assert.ok(disk(guide).includes('agent conflicting line'), 'declining keeps the agent version');

  await fire('session_shutdown', { reason: 'quit' });
  assert.ok(await screenContains(doc, 'Pi exited; kept open'), 'quit leaves the modified editor');
  assert.deepEqual(docPanes(owner), [doc]);
  tmux('send-keys', '-t', doc, ':w!', 'Enter');
  await waitFor(() => disk(guide).includes('unsaved user line'), 'the user can still keep their version');
  await fire('session_shutdown', { reason: 'quit' });
  await waitFor(() => docPanes(owner).length === 0, 'a clean editor closes on quit');
});

test('mixed code and Markdown changes show the editor and park Hunk; closing the editor is respected', async () => {
  await fire('before_agent_start', {});
  await tool('edit', () => { appendFileSync(join(repo, 'tracked.txt'), 'mixed code\n'); appendFileSync(notes, 'mixed notes\n'); });
  const [doc] = docPanes(owner), [diff] = diffPanes(owner);
  assert.ok(doc && diff, 'both previews open');
  assert.equal(tmux('display-message', '-p', '-t', owner, '#{pane_active}'), '1', 'Pi keeps focus');
  assert.ok(await screenContains(doc, 'mixed notes'));
  assert.ok(await screenContains(diff, 'mixed code'));
  tmux('send-keys', '-t', doc, ':q', 'Enter');
  await waitFor(() => docPanes(owner).length === 0, ':q closes the editor');
  await tool('edit', () => appendFileSync(notes, 'after close\n'));
  assert.deepEqual(docPanes(owner), [], 'stays closed until the next prompt');
  assert.deepEqual(diffPanes(owner), [diff]);
  await fire('session_shutdown', { reason: 'quit' });
  assert.deepEqual(diffPanes(owner), []);
  git('add', '-A'); git('commit', '-qm', 'markdown');
});

test('deleting a Markdown file shows the deletion in Hunk, not the editor', async () => {
  await fire('before_agent_start', {});
  await tool('bash', () => rmSync(guide));
  assert.deepEqual(docPanes(owner), []);
  const [diff] = diffPanes(owner);
  assert.ok(await screenContains(diff, 'guide.md'));
  await fire('session_shutdown', { reason: 'quit' });
  git('checkout', 'guide.md');
});

test('Hunk with nothing to show exits at startup and marks the Pi pane', async () => {
  const extension = join(root, 'extensions/hunk/close-when-empty.mjs');
  const hunk = tmux('split-window', '-d', '-h', '-P', '-F', '#{pane_id}', '-t', owner, '-c', repo,
    '-e', 'HUNK_MCP_DISABLE=1', '-e', `PI_DIFF_OWNER=${owner}`, 'hunk', 'diff', 'HEAD', '--watch', '--extension', extension);
  await waitFor(() => !panes().some(([id]) => id === hunk), 'an empty Hunk exits');
  const mark = `@pi_diff_empty_${hunk.slice(1)}`;
  assert.equal(tmux('show-options', '-pqv', '-t', owner, mark), '1', 'the mark names the Hunk pane that closed');
  tmux('set-option', '-pu', '-t', owner, mark);
});

test('a diff that becomes empty closes Hunk without counting as dismissal; a filter does not', async () => {
  await fire('before_agent_start', {});
  const tracked = join(repo, 'tracked.txt');
  await tool('edit', () => appendFileSync(tracked, 'reverted soon\n'));
  const [first] = diffPanes(owner);
  assert.ok(await screenContains(first, 'reverted soon'));
  git('checkout', 'tracked.txt');
  await waitFor(() => diffPanes(owner).length === 0, 'Hunk closes when its diff becomes empty');

  await tool('edit', () => appendFileSync(tracked, 'reopened\n'));
  const [second] = diffPanes(owner);
  assert.ok(second, 'a later change in the same prompt reopens it');
  assert.ok(await screenContains(second, 'reopened'));
  tmux('send-keys', '-t', second, 'Tab');
  await sleep(300);  // the filter takes focus before typing reaches it
  tmux('send-keys', '-t', second, 'zzz-no-match');
  assert.ok(await screenContains(second, 'No files match the current filter.'));
  appendFileSync(tracked, 'refresh while filtered\n');
  await sleep(1500);
  assert.deepEqual(diffPanes(owner), [second], 'filtering every file away keeps the pane');

  // Reverting immediately races Hunk's startup: whichever load sees the clean tree closes it, silently.
  git('checkout', 'tracked.txt');
  await waitFor(() => diffPanes(owner).length === 0, 'closes again');
  await tool('edit', () => appendFileSync(tracked, 'instant revert\n'));
  git('checkout', 'tracked.txt');
  await waitFor(() => panes().length === 1, 'the racing pane closes');
  await tool('edit', () => appendFileSync(tracked, 'still allowed\n'));
  assert.equal(diffPanes(owner).length, 1, 'still not treated as dismissed');
  assert.deepEqual(notices, [], 'no spurious missing-pane errors');
  await fire('session_shutdown', { reason: 'quit' });
  git('checkout', 'tracked.txt');
});

test('/edit opens unchanged files, reopens a dismissed pane and preserves unsaved writing', async () => {
  const command = extension.commands.get('edit');
  assert.ok(command, 'command is registered with the real Pi loader');
  const file = join(dir, 'manual notes.md');
  writeFileSync(file, '# Manual\n\nunchanged document\n');
  const other = join(dir, 'other.md');
  writeFileSync(other, '# Another document\n');
  const ctx = { ...context, cwd: dir }; // no Git repository or agent edit required
  await command.handler('"manual notes.md"', ctx);
  const [pane] = docPanes(owner);
  assert.ok(await screenContains(pane, 'unchanged document'));
  assert.deepEqual(diffPanes(owner), []);
  tmux('send-keys', '-t', pane, 'G', 'o', 'unsaved manual text', 'Escape');
  assert.ok(await screenContains(pane, 'unsaved manual text'));
  // An explicit /edit switches documents; the unsaved text stays in its buffer, unsaved on disk.
  await command.handler(other, ctx);
  assert.deepEqual(docPanes(owner), [pane], 'reuses existing editor');
  assert.ok(await screenContains(pane, 'Another document'), 'shows the requested document');
  assert.equal(disk(file), '# Manual\n\nunchanged document\n', 'no automatic save');
  await command.handler(file, ctx);
  assert.ok(await screenContains(pane, 'unsaved manual text'), 'the first document still has its unsaved text');
  tmux('send-keys', '-t', pane, ':wq', 'Enter');
  await waitFor(() => docPanes(owner).length === 0, 'user saved and closed');
  await command.handler(file, ctx);
  const [reopened] = docPanes(owner);
  assert.ok(await screenContains(reopened, 'unsaved manual text'), 'explicit command reopens within same prompt');
  await fire('session_shutdown', { reason: 'quit' });
  await waitFor(() => docPanes(owner).length === 0, 'clean editor closed');
  await command.handler('', ctx);
  assert.match(notices.pop(), /Usage: \/edit/);
  await command.handler('does-not-exist.md', ctx);
  assert.match(notices.pop(), /File not found/);
  assert.deepEqual(docPanes(owner), [], 'invalid path does not open a pane');
});

test('/panel takes a document path or tab name, like /edit; preview names keep precedence', async () => {
  const panel = async (args, ctx) => { await extension.commands.get('panel').handler(args, ctx); return notices.pop(); };
  const plan = join(dir, 'PLAN.md'), other = join(dir, 'other-panel.md'), nested = join(dir, 'sub', 'PLAN.md');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(plan, '# Plan\n\nplan text\n');
  writeFileSync(other, '# Other\n\nother panel text\n');
  writeFileSync(nested, '# Nested plan\n\nnested text\n');
  const here = { ...context, cwd: dir }, elsewhere = { ...context, cwd: repo };
  const shows = text => { const [pane] = docPanes(owner); return pane && tmux('capture-pane', '-p', '-t', pane).includes(text); };
  try {
    assert.match(await panel('PLAN.md', here), /Showing PLAN\.md in the editor/);
    await waitFor(() => shows('plan text'), 'a path opens the document in the editor');
    await panel('"other-panel.md"', here);
    await waitFor(() => shows('other panel text'), 'another path switches the editor');
    await panel('PLAN.md', elsewhere);
    await waitFor(() => shows('plan text'), 'from another directory, the one tab of that name is chosen');
    assert.match(await panel('edit', here), /Showing edit/, 'a preview name keeps its meaning');

    await extension.commands.get('edit').handler('sub/PLAN.md', here);
    await waitFor(() => shows('nested text'), 'a second PLAN.md is open');
    assert.match(await panel('PLAN.md', elsewhere), /PLAN\.md matches several documents; give its path: .*PLAN\.md, .*sub\/PLAN\.md/);
    assert.ok(shows('nested text'), 'an ambiguous name changes nothing');
    assert.match(await panel('missing.md', here), /No preview, document tab or file named missing\.md \(no file at .*missing\.md\)/);
  } finally {
    await fire('session_shutdown', { reason: 'quit' });
    await waitFor(() => docPanes(owner).length === 0, 'the clean editor closes');
  }
});

test('the show_panel tool lets the agent open a document as /panel does', async () => {
  const show = (params, ctx) => extension.tools.get('show_panel').definition.execute('call', params, undefined, undefined, ctx);
  const doc = join(dir, 'agent-shown.md');
  writeFileSync(doc, '# Shown\n\nshown by the agent\n');
  const shows = text => { const [pane] = docPanes(owner); return pane && tmux('capture-pane', '-p', '-t', pane).includes(text); };
  try {
    // An absolute path from another working directory, as for a file in another repository.
    const result = await show({ name: doc }, context);
    assert.match(result.content[0].text, /Showing agent-shown\.md in the editor/);
    await waitFor(() => shows('shown by the agent'), 'the tool opens the document beside Pi');
    assert.match((await show({ name: 'agent-shown.md' }, context)).content[0].text, /Showing agent-shown\.md/, 'a tab name works too');
    assert.match((await show({ name: 'nowhere.md' }, context)).content[0].text, /No preview, document tab or file named nowhere\.md/);
    await assert.rejects(show({ name: doc }, { ...context, mode: 'rpc' }), /needs Pi running inside tmux/);
  } finally {
    await fire('session_shutdown', { reason: 'quit' });
    await waitFor(() => docPanes(owner).length === 0, 'the clean editor closes');
  }
});

test('skill Markdown the agent edits or writes becomes a document tab, outside any watched repository', async () => {
  // A skills folder outside the repository and Git, as in ~/.agent-skills; Pi works in the repository.
  const skill = join(dir, 'skills-home', 'demo'), loose = join(dir, 'skills-home', 'loose.md');
  mkdirSync(join(skill, 'references'), { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), '# Demo skill\n');
  writeFileSync(loose, '# Not in a skill\n');
  const reference = join(skill, 'references', 'guide.md');
  const call = (name, path, change) => tool(name, change, context, extension, { path });
  const listed = () => tmux('show-options', '-pqv', '-t', owner, '@pi_docs').split('\n').filter(Boolean);
  const shows = text => { const [pane] = docPanes(owner); return pane && tmux('capture-pane', '-p', '-t', pane).includes(text); };
  await fire('before_agent_start', {});  // a new prompt: earlier tests closed the editor
  try {
    await call('edit', loose, () => appendFileSync(loose, 'loose edit\n'));
    await call('edit', join(skill, 'SKILL.md'), () => {});  // an edit that changed nothing
    assert.deepEqual(docPanes(owner), [], 'Markdown outside a skill, or an unchanged skill file, opens nothing');

    await call('write', reference, () => writeFileSync(reference, '# Guide\n\nnew reference text\n'));
    await waitFor(() => shows('new reference text'), 'a new skill reference opens in the editor');
    await call('edit', join(skill, 'SKILL.md'), () => appendFileSync(join(skill, 'SKILL.md'), 'edited skill body\n'));
    await waitFor(() => shows('edited skill body'), 'an edited SKILL.md opens in the editor');
    assert.deepEqual(listed().sort(), [join(skill, 'SKILL.md'), reference].sort(), 'both are document tabs; the loose file is not');
    // A new skill: its SKILL.md did not exist before the write.
    const fresh = join(dir, 'skills-home', 'fresh');
    mkdirSync(fresh);
    await call('write', join(fresh, 'SKILL.md'), () => writeFileSync(join(fresh, 'SKILL.md'), '# Fresh skill\n\nbrand new skill\n'));
    await waitFor(() => shows('brand new skill'), "a new skill's SKILL.md opens in the editor");
    assert.ok(listed().includes(join(fresh, 'SKILL.md')));

    // A removed document leaves the editor and loses its tab (a deleted worktree, say).
    rmSync(reference);
    await waitFor(() => !tmux('show-options', '-pqv', '-t', owner, '@pi_panels').includes('guide.md'), 'the removed document has no tab');
    assert.ok(tmux('show-options', '-pqv', '-t', owner, '@pi_panels').includes('SKILL.md'), 'the other documents keep their tabs');
  } finally {
    await fire('session_shutdown', { reason: 'quit' });
    await waitFor(() => docPanes(owner).length === 0, 'the clean editor closes');
  }
});

test('/create makes an empty file and opens it; it never overwrites or creates folders', async () => {
  const create = async (args, ctx) => { await extension.commands.get('create').handler(args, ctx); return notices.pop(); };
  const here = { ...context, cwd: dir };
  const fresh = join(dir, 'new idea.md'), kept = join(dir, 'kept.md');
  writeFileSync(kept, '# Kept\n\nexisting text\n');
  try {
    assert.equal(await create('"new idea.md"', here), undefined, 'no warning');
    assert.equal(disk(fresh), '', 'an empty file at the path relative to Pi');
    const [pane] = docPanes(owner);
    await waitFor(() => tmux('capture-pane', '-p', '-t', pane).includes('new idea.md'), 'the editor shows the new file');
    const current = tmux('show-options', '-pqv', '-t', pane, '@pi_doc_server');
    assert.equal(execFileSync('nvim', ['--clean', '--server', current, '--remote-expr', "expand('%:p')"], { encoding: 'utf8' }).trim(), realpathSync(fresh));

    assert.match(await create('kept.md', here), /Already exists: .*kept\.md\. Open it with \/edit or \/panel\./);
    assert.equal(disk(kept), '# Kept\n\nexisting text\n', 'the existing file is untouched');
    assert.match(await create('no-such-folder/x.md', here), /No such folder: .*no-such-folder/);
    assert.ok(!existsSync(join(dir, 'no-such-folder')), 'no folder is created');

    // Without Neovim, nothing is created.
    const { createDiffPane } = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
    await assert.rejects(createDiffPane({ nvim: '' }).create('never.md', here), /Install Neovim to use \/create/);
    assert.ok(!existsSync(join(dir, 'never.md')));
  } finally {
    await fire('session_shutdown', { reason: 'quit' });
    await waitFor(() => docPanes(owner).length === 0, 'the clean editor closes');
    rmSync(fresh, { force: true });
  }
});

test('a Hunk pane from before root tags is adopted by its directory after reload, not duplicated', async () => {
  for (const [id] of panes()) if (id !== owner) tmux('kill-pane', '-t', id);
  await fire('before_agent_start', {});
  const legacy = tmux('split-window', '-d', '-h', '-P', '-F', '#{pane_id}', '-t', owner, '-c', repo, 'sleep 60');
  tmux('set-option', '-p', '-t', legacy, '@pi_diff_owner', owner);
  await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'legacy\n'));
  assert.deepEqual(diffPanes(owner), [legacy]);
  assert.equal(tmux('show-options', '-pqv', '-t', legacy, '@pi_diff_root'), repo);
  tmux('kill-pane', '-t', legacy);
  git('checkout', 'tracked.txt');
});

test('pi.previewRoot repositories share one visible preview beside Pi; /panel switches; parked ones are windows', async () => {
  // Sibling repositories reached through a symlinked alias; the configured roots repeat the vault through that alias.
  const parent = join(dir, 'siblings'), main = join(parent, 'main'), vault = join(parent, 'vault');
  const alias = join(dir, 'alias');
  const commit = (cwd, files) => {
    execFileSync('git', ['init', '-q', cwd]);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
    execFileSync('git', ['add', '.'], { cwd });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base'], { cwd });
  };
  mkdirSync(parent);
  commit(main, { 'shared.txt': 'main base\n' });
  mkdirSync(join(vault, 'docs'), { recursive: true });
  commit(vault, { 'shared.txt': 'vault base\n', 'page.md': '# Page\n', 'docs/deep.md': '# Deep\n\ndeep vault text\n',
    '.gitignore': 'ignored.md\n', 'ignored.md': '# Ignored\n' });
  writeFileSync(join(parent, 'overview.md'), '# Overview\n\nparent overview text\n');  // the working directory's parent, outside Git
  commit(join(parent, 'clean'), { 'readme.txt': 'clean\n' });
  symlinkSync(parent, alias);
  const config = (...args) => execFileSync('git', ['config', ...args], { cwd: main });
  config('extensions.worktreeConfig', 'true');
  for (const value of ['../vault', '../../alias/vault', '.', '../missing', '../clean']) config('--worktree', '--add', 'pi.previewRoot', value);
  // A stand-in for the ccmux sidebar that tmux reports as `ccmux`, added to every new window as ccmux does.
  let sidebar = false;
  try {
    writeFileSync(join(dir, 'ccmux.c'), '#include <unistd.h>\nint main(void){for(;;)pause();}\n');
    execFileSync('cc', ['-o', join(dir, 'ccmux'), join(dir, 'ccmux.c')], { stdio: 'ignore' });
    tmux('set-hook', '-g', 'after-new-window', `split-window -bdfh -l 10 ${join(dir, 'ccmux')}`);
    sidebar = true;
  } catch {}
  const notes = [];
  const ctx = { ...context, cwd: join(alias, 'main'), ui: { notify: text => notes.push(text) } };
  // The Panels tab row Pi writes for its window (tmux/pi-tabs.conf shows it).
  const panelsRow = () => tmux('show-options', '-pqv', '-t', owner, '@pi_panels');
  // A real client, attached from a second server, for the tab rows below.
  const outer = (...args) => execFileSync('tmux', ['-L', `pi-diff-outer-${process.pid}`, ...args], { encoding: 'utf8' }).trim();
  outer('new-session', '-d', '-s', 'outer', '-x', '240', '-y', '50', `env -u TMUX tmux -L ${socketName} attach -t test`);
  await waitFor(() => tmux('list-clients'), 'a client attached');
  // /panels with Pi's selector stood in for: the real component is built, drawn and given `keys`
  // (strings are typed; Escape follows if nothing was chosen). Returns what it drew first.
  const key = { up: '\x1b[A', down: '\x1b[B', enter: '\r', escape: '\x1b' };
  const menu = async (keys, expect) => {
    let drawn = '', chosen = false;
    const ui = { ...ctx.ui, custom: factory => new Promise(resolve => {
      const theme = { fg: (_color, text) => text, bold: text => text };
      const component = factory({ requestRender() {} }, theme, undefined, value => { chosen = value !== undefined; resolve(value); });
      drawn = component.render(200).join('\n');
      for (const input of keys) for (const data of key[input] ? [key[input]] : [...input]) component.handleInput(data);
      if (!chosen) component.handleInput(key.escape);
    }) };
    await extension.commands.get('panels').handler('', { ...ctx, ui });
    for (const text of expect) assert.ok(drawn.includes(text), `selector shows ${text}:\n${drawn}\nnotes: ${notes.join(" / ")}`);
    await sleep(300);
    return { drawn, chosen };
  };
  const panel = async (args = '') => { await extension.commands.get('panel').handler(args, ctx); return notes.pop(); };
  const rootOf = pane => tmux('show-options', '-pqv', '-t', pane, '@pi_diff_root');
  const paneFor = root => diffPanes(owner).find(pane => rootOf(pane) === root);
  const windowOf = pane => tmux('display-message', '-p', '-t', pane, '#{window_id}');
  const piWindow = windowOf(owner);
  // Content panes in Pi's window other than Pi itself; the sidebar does not count.
  const beside = () => tmux('list-panes', '-t', piWindow, '-F', '#{pane_id} #{pane_current_command}').split('\n')
    .map(row => row.split(' ')).filter(([id, command]) => id !== owner && command !== 'ccmux').map(([id]) => id);
  // Parked windows, by name; Pi's own window is renamed automatically, so it is excluded by id.
  const windows = () => tmux('list-windows', '-F', '#{window_id} #{window_name}').split('\n')
    .map(row => row.split(' ')).filter(([id]) => id !== piWindow).map(([, name]) => name);
  for (const [id] of panes()) if (id !== owner) tmux('kill-pane', '-t', id);
  await fire('before_agent_start', {});
  // Nothing changed yet: every item is disabled, the first one included.
  const first = await menu([], ['Show beside Pi', 'main · no changes', 'vault · no changes', 'clean · no changes',
    'page.md vault/page.md', 'deep.md vault/docs/deep.md', 'overview.md']);
  assert.ok(!first.drawn.includes('ignored.md'), 'files Git ignores are not listed');
  assert.deepEqual(diffPanes(owner), []);

  await tool('bash', () => appendFileSync(join(vault, 'shared.txt'), 'vault edit\n'), ctx);
  const vaultDiff = paneFor(vault);
  assert.deepEqual(diffPanes(owner), [vaultDiff], 'a vault-only change opens one pane; the unchanged main repository opens none');
  assert.deepEqual(beside(), [vaultDiff], 'beside Pi');
  assert.ok(await screenContains(vaultDiff, 'vault base'), 'compares against the vault HEAD');
  assert.ok(!screen(vaultDiff).includes('main base'));
  assert.deepEqual(notes, ['Diff pane: pi.previewRoot is not a Git repository: ../missing'], 'warned once; the valid roots still work');
  notes.length = 0;

  await tool('edit', () => appendFileSync(join(main, 'shared.txt'), 'main edit\n'), ctx);
  const mainDiff = paneFor(main);
  assert.equal(diffPanes(owner).length, 2, 'one Hunk per repository, none duplicated');
  assert.deepEqual(beside(), [mainDiff], 'the newest change takes the one visible slot');
  assert.deepEqual(windows(), ['diff:vault'], 'the other waits in a window named for it');
  assert.ok(await screenContains(mainDiff, 'main edit') && await screenContains(vaultDiff, 'vault edit'));
  assert.equal(tmux('display-message', '-p', '-t', owner, '#{pane_active}'), '1', 'Pi keeps focus');
  // The preview runs under the task wrapper, so tmux reports the wrapper's shell, not hunk.
  if (sidebar) assert.deepEqual(tmux('list-panes', '-t', windowOf(vaultDiff), '-F', '#{pane_id} #{pane_current_command}').split('\n')
    .map(row => row.split(' ')).map(([id, command]) => id === vaultDiff ? 'preview' : command).sort(), ['ccmux', 'preview'], 'a sidebar, as in every window');

  assert.match(await panel(), /Showing diff:vault/);
  assert.deepEqual(beside(), [vaultDiff]);
  assert.deepEqual(windows(), ['diff:main'], 'the parked window is renamed after what it now holds');
  assert.match(await panel('main'), /Showing diff:main/);
  assert.deepEqual(beside(), [mainDiff]);
  assert.match(await panel('nothing'), /No preview, document tab or file named nothing \(no file at .*\/main\/nothing\)\. Open previews: vault, main/);
  assert.ok(panelsRow().includes('#[reverse] Diff: main ') && panelsRow().includes(' Diff: vault ') && !panelsRow().includes('clean'),
    'the Panels row has a tab per open preview, the one beside Pi highlighted, none for a clean repository');

  // The selector lists the same; Enter shows that preview; a repository with no changes cannot be chosen.
  await menu(['down', 'enter'], ['main · 1 changed, beside Pi', 'vault · 1 changed, window', 'clean · no changes']);
  await waitFor(() => panelsRow().includes('#[reverse] Diff: vault '), 'the Panels row follows the choice');
  assert.deepEqual(beside(), [vaultDiff], 'the chosen preview is beside Pi');
  assert.equal((await menu(['down', 'down', 'enter'], ['clean · no changes'])).chosen, false, 'Enter on a repository with no changes chooses nothing');
  assert.deepEqual(beside(), [vaultDiff], 'and shows nothing new');
  assert.equal(diffPanes(owner).length, 2, 'and opens no empty Hunk');
  await menu(['escape'], []);
  await menu(['main', 'enter'], []);
  await waitFor(() => panelsRow().includes('#[reverse] Diff: main '), 'typing filters; the next selector still works');
  assert.deepEqual(beside(), [mainDiff]);

  // Both repositories in one turn, with Markdown: the one editor is shown; both Hunks wait.
  await tool('bash', () => {
    appendFileSync(join(main, 'shared.txt'), 'both main\n');
    appendFileSync(join(vault, 'shared.txt'), 'both vault\n');
    appendFileSync(join(vault, 'page.md'), 'vault page edit\n');
  }, ctx);
  const [doc] = docPanes(owner);
  assert.deepEqual(beside(), [doc], 'never a third visible split');
  assert.deepEqual(windows().sort(), ['diff:main', 'diff:vault']);
  assert.ok(await screenContains(doc, 'vault page edit'));
  assert.ok(await screenContains(vaultDiff, 'both vault') && await screenContains(mainDiff, 'both main'));

  // An editor with unsaved text, or one the user is in, is not moved out of view by agent changes.
  tmux('send-keys', '-t', doc, 'G', 'o', 'unsaved vault text', 'Escape');
  assert.ok(await screenContains(doc, 'unsaved vault text'));
  await tool('bash', () => appendFileSync(join(main, 'shared.txt'), 'while editing\n'), ctx);
  assert.deepEqual(beside(), [doc]);
  assert.deepEqual(notes, ['diff:main changed; /panel main shows it']);
  await tool('write', () => writeFileSync(join(main, 'readme.md'), '# Main readme\n'), ctx);
  assert.deepEqual(docPanes(owner), [doc], 'one editor for both repositories');
  assert.ok(await screenContains(doc, 'Also requested:') && screen(doc).includes('main/readme.md'), 'unsaved vault text is protected');

  // Explicitly parking the modified editor keeps it running; quit brings it back beside Pi.
  assert.match(await panel('vault'), /Showing diff:vault/);
  assert.deepEqual(windows().sort(), ['diff:main', 'edit']);
  assert.ok(screen(doc).includes('unsaved vault text'), 'the parked editor keeps its text');
  await fire('session_shutdown', { reason: 'quit' }, ctx);
  await waitFor(() => diffPanes(owner).length === 0, 'quit closes every Hunk');
  assert.deepEqual(beside(), [doc], 'the modified editor is beside Pi, not hidden');
  assert.ok(await screenContains(doc, 'Pi exited; kept open'));
  assert.deepEqual(windows(), [], 'no parked or sidebar-only windows remain');
  tmux('send-keys', '-t', doc, ':q!', 'Enter');
  await waitFor(() => docPanes(owner).length === 0, 'the user closes it');

  // Dismissal is per preview; a parked preview that exits leaves no sidebar-only window.
  await fire('before_agent_start', {});
  await tool('bash', () => { appendFileSync(join(main, 'shared.txt'), 'm\n'); appendFileSync(join(vault, 'shared.txt'), 'v\n'); }, ctx);
  const parked = diffPanes(owner).find(pane => !beside().includes(pane));
  tmux('send-keys', '-t', parked, 'q');
  await waitFor(() => windows().length === 0, 'the parked window closes with its preview');
  await tool('bash', () => { appendFileSync(join(main, 'shared.txt'), 'm2\n'); appendFileSync(join(vault, 'shared.txt'), 'v2\n'); }, ctx);
  assert.equal(diffPanes(owner).length, 1, 'the closed preview stays closed this prompt');
  const closed = rootOf(diffPanes(owner)[0]) === main ? 'vault' : 'main';
  await menu(closed === 'main' ? ['enter'] : ['down', 'enter'], [`${closed} · 2 changed`]);
  await waitFor(() => diffPanes(owner).length === 2 && rootOf(beside()[0]) === (closed === 'main' ? main : vault),
    'choosing it from the menu reopens it beside Pi');

  // Any Markdown file listed opens in the editor: a nested tracked one, and one in the parent folder.
  await menu(['deep', 'enter'], []);
  await waitFor(() => docPanes(owner).length === 1 && screen(docPanes(owner)[0]).includes('deep vault text'), 'a chosen file opens in the editor');
  await menu(['overview', 'enter'], []);
  await waitFor(() => screen(docPanes(owner)[0]).includes('parent overview text'), 'a file in the parent folder too');
  assert.match(panelsRow(), /deep\.md.*overview\.md|overview\.md.*deep\.md/, 'both are now document tabs');
  await fire('session_shutdown', { reason: 'quit' }, ctx);
  await waitFor(() => diffPanes(owner).length === 0 && docPanes(owner).length === 0, 'closed');
  tmux('set-hook', '-gu', 'after-new-window');
  outer('kill-server');
});

// A real client, attached from a second server with the tab rows installed, driven by injected
// terminal mouse events.
async function tabClient() {
  for (const [id] of panes()) if (id !== owner) tmux('kill-pane', '-t', id);
  tmux('source-file', join(root, 'tmux/pi-tabs.conf'));
  const outer = (...args) => execFileSync('tmux', ['-L', `pi-tabs-outer-${process.pid}`, ...args], { encoding: 'utf8' }).trim();
  outer('new-session', '-d', '-s', 'outer', '-x', '200', '-y', '40', `env -u TMUX tmux -L ${socketName} attach -t test`);
  await waitFor(() => tmux('list-clients'), 'a client attached');
  const screen = () => outer('capture-pane', '-p', '-t', 'outer');
  const rows = () => screen().split('\n').slice(-2);
  // Separate gestures, as a person makes them: a synthetic click 17 ms after choosing a menu item
  // by mouse did not reach the binding, while clicks 400 ms apart do. The pause comes before reading
  // positions, since a redrawn row (an unsaved marker appearing) moves the tabs.
  const pause = () => execFileSync('sleep', ['0.4']);
  const press = (x, y) => {
    outer('send-keys', '-t', 'outer', '-l', `\x1b[<0;${x};${y}M`);
    outer('send-keys', '-t', 'outer', '-l', `\x1b[<0;${x};${y}m`);
  };
  return {
    outer, screen, rows,
    // At the first `text` (after `after`) in a bottom row: 0 Windows, 1 Panels.
    click(row, text, after = '') {
      pause();
      const line = rows()[row];
      const col = line.indexOf(text, after ? line.indexOf(after) : 0);
      assert.ok(col >= 0, `${text} in ${JSON.stringify(line)}`);
      press([...line.slice(0, col)].length + 1, 39 + row);
    },
    // On menu text anywhere on screen.
    clickText(text) {
      pause();
      const lines = screen().split('\n');
      const y = lines.findIndex(line => line.includes(text));
      assert.ok(y >= 0, `${text} on screen`);
      press([...lines[y].slice(0, lines[y].indexOf(text))].length + 1, y + 1);
    },
    close() { try { outer('kill-server'); } catch {} tmux('set', '-g', 'status', 'on'); },
  };
}

test('bottom tab rows: real mouse clicks select and close previews and windows; unsaved text is kept', async () => {
  const client = await tabClient();
  const { outer, rows, click, clickText } = client;
  const screenOuter = client.screen;
  assert.equal(realpathSync(tmux('show-options', '-gv', '@pi_tabs')), join(root, 'scripts/tmux-tabs.mjs'), 'the config finds its helper from its own location');
  try {
    const beside = () => tmux('list-panes', '-t', owner, '-F', '#{pane_id}').split('\n').filter(id => id !== owner);
    const screenOuter = () => outer('capture-pane', '-p', '-t', 'outer');

    await fire('before_agent_start', {});
    await fire('session_start', {});
    await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'tab code\n'));
    await tool('write', () => writeFileSync(notes, '# Notes\n\ntab notes\n'));
    const [diff] = diffPanes(owner), [doc] = docPanes(owner);
    assert.deepEqual(beside(), [doc], 'the editor is beside Pi; Hunk waits');
    await waitFor(() => /^Panels +✎ Write +Diff: repo ×.* notes\.md ×/.test(rows()[1]), 'the Panels row names both previews, after the writing view\'s switch');
    assert.match(rows()[0], /^Windows .*π /, 'the Windows row is labelled and marks Pi');
    assert.ok(!rows()[0].includes('diff:repo'), 'the waiting preview is not also a window tab');

    const evidence = process.env.DIFF_PANE_EVIDENCE;
    if (evidence) writeFileSync(join(evidence, 'tab-rows-open.txt'), screenOuter());
    click(1, 'Diff: repo');
    await waitFor(() => beside()[0] === diff, 'clicking a Panels tab shows it beside Pi');
    await waitFor(() => tmux('show-options', '-pqv', '-t', owner, '@pi_panels').includes('#[range=user|ps' + diff + ']#[reverse]'), 'the shown tab is highlighted');

    // Unsaved editor text: × asks; Escape keeps it; Save writes and closes.
    tmux('send-keys', '-t', doc, 'G', 'o', 'unsaved tab text', 'Escape');
    await waitFor(() => rows()[1].includes('notes.md ●'), 'the tab marks unsaved text');
    click(1, '×', 'notes.md');
    await waitFor(() => screenOuter().includes('Unsaved changes in notes.md'), 'closing asks');
    outer('send-keys', '-t', 'outer', 'Escape');
    await sleep(500);
    assert.deepEqual(docPanes(owner), [doc], 'Escape keeps the editor');
    click(1, '×', 'notes.md');
    await waitFor(() => screenOuter().includes('Save and close'), 'asks again');
    outer('send-keys', '-t', 'outer', 's');
    await waitFor(() => docPanes(owner).length === 0, 'Save and close closes it');
    assert.ok(disk(notes).includes('unsaved tab text'), 'the text was saved');
    await waitFor(() => !rows()[1].includes('notes.md'), 'its tab is gone');

    // Closing Hunk from its tab counts as the user closing it.
    click(1, '×', 'Diff: repo');
    await waitFor(() => diffPanes(owner).length === 0, 'the Hunk tab closes it');
    await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'after tab close\n'));
    assert.deepEqual(diffPanes(owner), [], 'it stays closed this prompt');

    // Windows: × asks before closing, naming a Pi session when it would end one.
    const spare = tmux('new-window', '-d', '-P', '-F', '#{window_id}', '-n', 'spare', 'sleep 300');
    await waitFor(() => rows()[0].includes('spare'), 'the new window has a tab');
    click(0, '×', 'spare');
    await waitFor(() => /Close window \d+:spare\? This ends: sleep\./.test(screenOuter()), 'closing a window asks');
    clickText('Keep window');
    await waitFor(() => !screenOuter().includes('Keep window'), 'clicking a menu item chooses it');
    assert.ok(tmux('list-windows', '-F', '#{window_id}').includes(spare), 'Keep window keeps it');
    click(0, '×', 'spare');
    await waitFor(() => screenOuter().includes('Close window'), 'asks again');
    outer('send-keys', '-t', 'outer', 'c');
    await waitFor(() => !tmux('list-windows', '-F', '#{window_id}').includes(spare), 'Close window closes it');
    click(0, '×', 'π');
    await waitFor(() => screenOuter().includes('This ends the running Pi session.'), 'the Pi window says what closing it ends');
    if (evidence) writeFileSync(join(evidence, 'pi-window-close.txt'), screenOuter());
    outer('send-keys', '-t', 'outer', 'Escape');
    await sleep(300);
    assert.ok(panes().some(([id]) => id === owner), 'Escape keeps Pi running');
    if (evidence) writeFileSync(join(evidence, 'tab-rows.txt'), screenOuter());
    git('checkout', 'tracked.txt');
  } finally {
    client.close();
  }
});

test('document tabs: each Markdown document from agent changes and /edit stays a tab; clicks switch it in one editor; unsaved text is kept', async () => {
  const client = await tabClient();
  const { rows, click, screen } = client;
  const editor = () => docPanes(owner)[0];
  const editorShows = text => tmux('capture-pane', '-p', '-t', editor()).includes(text);
  const docs = { a: join(repo, 'alpha.md'), b: join(repo, 'beta.md'), c: join(dir, 'gamma.md') };
  writeFileSync(docs.c, '# Gamma\n\ngamma text\n');
  try {
    await fire('before_agent_start', {});
    await fire('session_start', {});
    await tool('write', () => { writeFileSync(docs.a, '# Alpha\n\nalpha text\n'); writeFileSync(docs.b, '# Beta\n\nbeta text\n'); });
    await waitFor(() => /alpha\.md ×.*beta\.md ×/.test(rows()[1]), 'every document the agent changed has a tab');
    await extension.commands.get('edit').handler(docs.c, context);
    await waitFor(() => rows()[1].includes('gamma.md ×') && editorShows('gamma text'), '/edit adds a tab and shows it');
    assert.equal(docPanes(owner).length, 1, 'one editor');

    // The ccmux sidebar being the active pane does not empty the row.
    const sidebar = tmux('split-window', '-d', '-b', '-h', '-l', '10', '-P', '-F', '#{pane_id}', '-t', owner, 'sleep 300');
    tmux('select-pane', '-t', sidebar);
    await waitFor(() => rows()[1].includes('gamma.md'), 'the row stays while another pane of the window is active');
    tmux('select-pane', '-t', owner);
    tmux('kill-pane', '-t', sidebar);

    client.click(1, 'alpha.md');
    await waitFor(() => editorShows('alpha text'), 'clicking a document tab switches the editor to it');
    tmux('send-keys', '-t', editor(), 'G', 'o', 'unsaved alpha', 'Escape');
    await waitFor(() => rows()[1].includes('alpha.md ●'), 'its tab marks unsaved text');
    click(1, 'beta.md');
    await waitFor(() => editorShows('beta text'), 'switching away from unsaved text is allowed');
    click(1, 'alpha.md');
    await waitFor(() => editorShows('unsaved alpha'), 'and the unsaved text is still there');

    // Reload keeps the tabs.
    await fire('session_shutdown', { reason: 'reload' });
    const reloaded = await load();
    await fire('session_start', {}, context, reloaded);
    await waitFor(() => /alpha\.md ●.*beta\.md.*gamma\.md/.test(rows()[1]), 'tabs survive /reload');

    // × on the unsaved document asks; Escape keeps it; Save writes it and closes only that tab.
    click(1, '×', 'alpha.md');
    await waitFor(() => screen().includes('Unsaved changes in alpha.md'), 'closing asks');
    client.outer('send-keys', '-t', 'outer', 'Escape');
    await sleep(500);
    assert.ok(rows()[1].includes('alpha.md ●') && editorShows('unsaved alpha'), 'Escape keeps the document and its text');
    click(1, '×', 'alpha.md');
    await waitFor(() => screen().includes('Save and close'), 'asks again');
    client.outer('send-keys', '-t', 'outer', 's');
    await waitFor(() => !rows()[1].includes('alpha.md'), 'Save and close removes its tab');
    assert.ok(disk(docs.a).includes('unsaved alpha'), 'the text was saved');
    assert.ok(rows()[1].includes('beta.md') && rows()[1].includes('gamma.md') && editor(), 'the other documents and the editor remain');

    // A clean document closes at once.
    click(1, '×', 'beta.md');
    await waitFor(() => !rows()[1].includes('beta.md'), 'a clean document closes without asking');
    assert.ok(editor(), 'the editor stays for the remaining document');

    // Documents stay reachable when the editor is closed.
    tmux('send-keys', '-t', editor(), ':qa', 'Enter');
    await waitFor(() => !editor(), 'the user closes the editor');
    await fire('turn_end', {});
    assert.ok(rows()[1].includes('gamma.md'), 'its document keeps its tab');
    click(1, 'gamma.md');
    await waitFor(() => editor() && editorShows('gamma text'), 'clicking it opens the editor again');

    // Closing the last document closes the editor.
    click(1, '×', 'gamma.md');
    await waitFor(() => !editor() && !rows()[1].includes('gamma.md'), 'the last document closes the editor');
  } finally {
    client.close();
    for (const file of [docs.a, docs.b]) rmSync(file, { force: true });
  }
});

test('document switches show the document even after its file changed under unsaved text; tabs act only for their own Pi', async () => {
  const client = await tabClient();
  const { rows, click } = client;
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const files = { one: join(dir, 'one.md'), two: join(dir, 'two.md'), other: join(dir, 'other.md') };
  for (const [name, file] of Object.entries(files)) writeFileSync(file, `# ${name}\n\n${name} text\n`);
  const shows = (pane, text) => tmux('capture-pane', '-p', '-t', pane).includes(text);
  let otherPi;
  try {
    await fire('before_agent_start', {});
    await fire('session_start', {});
    await extension.commands.get('edit').handler(files.one, context);
    await extension.commands.get('edit').handler(files.two, context);
    const [editor] = docPanes(owner);
    // A second Pi in its own window, with its own editor and document.
    otherPi = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', 'sleep 300');
    await lib.selectDocument(otherPi, files.other);
    await lib.renderPanels(otherPi);
    const [otherEditor] = docPanes(otherPi);
    await waitFor(() => shows(otherEditor, 'other text'), 'the other Pi has its editor');

    click(1, 'one.md');
    await waitFor(() => shows(editor, 'one text'), 'the click shows the document, not only its tab');
    tmux('send-keys', '-t', editor, 'G', 'o', 'unsaved one', 'Escape');
    await waitFor(() => rows()[1].includes('one.md ●'), 'the tab marks unsaved text');
    click(1, 'two.md');
    await waitFor(() => shows(editor, 'two text'), 'switched away');
    await sleep(1200);
    writeFileSync(files.one, '# one\n\nagent rewrite\n');
    click(1, 'one.md');
    await waitFor(() => shows(editor, 'unsaved one') && shows(editor, 'Changed on disk; edits kept'),
      'the unsaved text is shown with the changed-on-disk note, without a blocking prompt');
    click(1, 'two.md');
    await waitFor(() => shows(editor, 'two text') && !shows(editor, 'unsaved one'), 'the next click shows the next document');
    assert.ok(disk(files.one).includes('agent rewrite'), 'the file on disk is the agent version');

    assert.ok(!rows()[1].includes('other.md'), 'the other Pi’s document is not in this row');
    assert.deepEqual((await lib.documents(otherPi)).map(file => file.split('/').pop()), ['other.md']);
    assert.ok(shows(otherEditor, 'other text'), 'the other Pi’s editor is untouched');

    // A tab whose pane has gone (a preview from an older version that never redrew) is removed on click.
    // Injected once the editor's own redraws have settled, and confirmed still there, so a pending
    // redraw cannot remove it before the click.
    for (let tries = 0; ; tries++) {
      await sleep(800);
      const row = tmux('show-options', '-pqv', '-t', owner, '@pi_panels');
      if (!row.includes('Diff: gone')) tmux('set-option', '-p', '-t', owner, '@pi_panels', `${row}  #[range=user|ps%9999] Diff: gone #[norange]`);
      await sleep(800);
      if (rows()[1].includes('Diff: gone')) break;
      assert.ok(tries < 5, 'the stale tab stays long enough to click');
    }
    click(1, 'Diff: gone');
    await waitFor(() => !rows()[1].includes('Diff: gone') && rows()[1].includes('two.md'), 'the click redraws the row without it');
  } finally {
    for (const pane of [...docPanes(owner), ...(otherPi ? docPanes(otherPi) : [])]) tmux('kill-pane', '-t', pane);
    if (otherPi) tmux('kill-pane', '-t', otherPi);
    tmux('set-option', '-pu', '-t', owner, '@pi_docs');
    client.close();
  }
});

test('writing view: two documents side by side in Pi\'s editor, Pi unseen but running; tabs fill the focused side; unsaved text survives every transition', async () => {
  const client = await tabClient();
  const { rows, click } = client;
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const docs = { a: join(dir, 'wa.md'), b: join(dir, 'wb.md'), c: join(dir, 'wc.md'), d: join(repo, 'wd.md') };
  for (const [name, file] of Object.entries(docs)) writeFileSync(file, `# ${name}\n\n${name} text\n`);
  const editor = () => docPanes(owner)[0];
  const windowOf = pane => tmux('display-message', '-p', '-t', pane, '#{window_id}');
  const piWindow = windowOf(owner);
  const nvim = expr => execFileSync('nvim', ['--clean', '--server', tmux('show-options', '-pqv', '-t', editor(), '@pi_doc_server'), '--remote-expr', expr],
    { encoding: 'utf8', timeout: 3000 }).trim();
  const sides = () => JSON.parse(nvim("json_encode(map(filter(getwininfo(), 'getwinvar(v:val.winid, \"&winfixbuf\") == 0'), 'fnamemodify(bufname(v:val.bufnr), \":t\")'))"));
  const focused = () => nvim("expand('%:t')");
  const state = async () => lib.editorState('nvim', editor());
  const unsaved = async () => [...(await state()).unsaved].map(file => basename(file)).sort();
  const clientWindow = () => tmux('display-message', '-p', '-c', tmux('list-clients', '-F', '#{client_name}'), '#{window_id}');
  try {
    await fire('before_agent_start', {});
    await fire('session_start', {});
    for (const file of [docs.a, docs.b, docs.c]) await extension.commands.get('edit').handler(file, context);
    await waitFor(() => /^Panels +✎ Write +wa\.md ×.*wb\.md ×.*wc\.md ×/.test(rows()[1]), 'the switch leads the row once there are documents');

    // With the editor closed, the switch starts it on Pi's first document, beside the next.
    tmux('send-keys', '-t', editor(), ':qa', 'Enter');
    await waitFor(() => !editor(), 'the user closes the editor');
    await lib.renderPanels(owner);
    click(1, '✎ Write');
    await waitFor(() => editor() && windowOf(editor()) !== piWindow && clientWindow() === windowOf(editor()), 'the editor opens in its own window, shown');
    await waitFor(() => JSON.stringify(sides()) === '["wa.md","wb.md"]', 'two documents side by side');
    const writingWindow = windowOf(editor());
    assert.equal(tmux('display-message', '-p', '-t', writingWindow, '#{window_name}'), 'write');
    assert.deepEqual(tmux('list-panes', '-t', piWindow, '-F', '#{pane_id}').split('\n'), [owner], 'Pi keeps its window, alone');
    assert.equal(tmux('display-message', '-p', '-t', owner, '#{pane_dead}'), '0', 'Pi still runs');
    await waitFor(() => rows()[1].includes('π Show agent'), 'the switch offers the way back');
    assert.ok(!rows()[0].includes(':write'), 'the writing window is not a Windows tab');
    assert.equal(focused(), 'wa.md');
    const evidence = process.env.DIFF_PANE_EVIDENCE;
    if (evidence) writeFileSync(join(evidence, 'writing-view.txt'), client.screen());
    // Each side has its own bar beneath it, naming its document.
    await waitFor(() => client.screen().split('\n').some(line => /wa\.md .*│?.*wb\.md/.test(line) && !line.includes('Writing view')),
      'each side names its document in its own bar');

    // Unsaved text on the focused side, then a tab click replaces only that side; the text stays behind it.
    tmux('send-keys', '-t', editor(), 'G', 'o', 'unsaved a', 'Escape');
    await waitFor(() => rows()[1].includes('wa.md ●'), 'the tab marks unsaved text');
    await waitFor(() => client.screen().split('\n').some(line => /wa\.md \[\+\] unsaved .*wb\.md/.test(line)), 'the side\'s bar marks it too');
    click(1, 'wc.md');
    await waitFor(() => JSON.stringify(sides()) === '["wc.md","wb.md"]', 'a tab click changes the focused side');
    assert.deepEqual(await unsaved(), ['wa.md'], 'the document left keeps its unsaved text');
    assert.equal(clientWindow(), writingWindow, 'the view stays');
    // A tab for a document on screen moves the cursor there instead.
    click(1, 'wb.md');
    await waitFor(() => focused() === 'wb.md', 'clicking the other side\'s document focuses it');
    assert.deepEqual(sides(), ['wc.md', 'wb.md'], 'nothing is replaced');
    const panels = tmux('show-options', '-pqv', '-t', editor(), '@pi_panels');
    for (const name of ['wb.md', 'wc.md']) assert.ok(panels.includes(`#[reverse] ${name}`), `${name}, on screen, is highlighted`);
    assert.ok(!panels.includes('#[reverse] wa.md'), 'a document behind is not');
    tmux('send-keys', '-t', editor(), 'G', 'o', 'unsaved b', 'Escape');
    click(1, 'wa.md');
    await waitFor(() => JSON.stringify(sides()) === '["wc.md","wa.md"]' && focused() === 'wa.md', 'the focused side (now the right) takes it');
    assert.ok(tmux('capture-pane', '-p', '-t', editor()).includes('unsaved a'), 'with its unsaved text');
    assert.deepEqual(await unsaved(), ['wa.md', 'wb.md']);

    // Closing a clean document on screen keeps both sides: one not on screen takes its place.
    click(1, '×', 'wc.md');
    await waitFor(() => JSON.stringify(sides()) === '["wb.md","wa.md"]', 'the closed side takes the document behind');
    await waitFor(() => !rows()[1].includes('wc.md'), 'its tab is gone');
    // Unsaved text on screen still asks.
    click(1, '×', 'wb.md');
    await waitFor(() => client.screen().includes('Unsaved changes in wb.md'), 'closing asks');
    client.outer('send-keys', '-t', 'outer', 'Escape');
    await sleep(500);
    assert.deepEqual(sides(), ['wb.md', 'wa.md'], 'Escape keeps it');

    // An agent change meanwhile adds its tab and does not take the editor out of the writing view.
    await tool('write', () => writeFileSync(docs.d, '# d\n\nagent d\n'));
    await waitFor(() => rows()[1].includes('wd.md'), 'the changed document has a tab');
    assert.equal(windowOf(editor()), writingWindow, 'the editor stays in the writing view');
    assert.deepEqual(await unsaved(), ['wa.md', 'wb.md'], 'unsaved text is untouched');
    notices = [];
    await extension.commands.get('panel').handler('edit', context);
    assert.equal(windowOf(editor()), writingWindow, '/panel edit leaves it too');
    assert.match(notices.join(' '), /writing view/, 'and says why');

    // A sidebar in the writing window makes the third panel; returning to agent view leaves no window behind.
    if (!existsSync(join(dir, 'ccmux'))) {
      writeFileSync(join(dir, 'ccmux.c'), '#include <unistd.h>\nint main(void){for(;;)pause();}\n');
      execFileSync('cc', ['-o', join(dir, 'ccmux'), join(dir, 'ccmux.c')], { stdio: 'ignore' });
    }
    tmux('split-window', '-bdfh', '-l', '20', '-t', writingWindow, join(dir, 'ccmux'));
    await waitFor(() => tmux('list-panes', '-t', writingWindow, '-F', '#{pane_current_command}').includes('ccmux'), 'a sidebar beside the two documents');
    if (evidence) writeFileSync(join(evidence, 'writing-view-sidebar.txt'), client.screen());
    const focusedBefore = focused();
    click(1, 'π Show agent');
    await waitFor(() => windowOf(editor()) === piWindow && clientWindow() === piWindow, 'the editor returns beside Pi, which is shown');
    await waitFor(() => sides().length === 1, 'with one document');
    assert.deepEqual(sides(), [focusedBefore], 'the side with the cursor');
    assert.ok(!tmux('list-windows', '-F', '#{window_id}').split('\n').includes(writingWindow), 'the writing window has gone, sidebar included');
    assert.deepEqual(await unsaved(), ['wa.md', 'wb.md'], 'the other side\'s unsaved text stays behind');
    await waitFor(() => rows()[1].includes('✎ Write'), 'the switch offers the writing view again');
    assert.equal(nvim('&laststatus'), '0', 'one document has its bar above it, as before');
    if (evidence) writeFileSync(join(evidence, 'writing-view-back.txt'), client.screen());

    // Pi quitting from the writing view brings the editor back first; unsaved text keeps it open.
    click(1, '✎ Write');
    await waitFor(() => windowOf(editor()) !== piWindow && sides().length === 2, 'the writing view again');
    await fire('session_shutdown', { reason: 'quit' });
    await waitFor(() => windowOf(editor()) === piWindow && sides().length === 1, 'quit brings the editor beside Pi');
    await sleep(500);
    assert.ok(editor(), 'unsaved text keeps it open');
    assert.deepEqual(await unsaved(), ['wa.md', 'wb.md']);
    assert.equal(tmux('show-options', '-pqv', '-t', editor(), '@pi_writing'), '', 'the writing mark is gone');
  } finally {
    for (const pane of docPanes(owner)) tmux('kill-pane', '-t', pane);
    tmux('set-option', '-pu', '-t', owner, '@pi_docs');
    client.close();
    for (const file of Object.values(docs)) rmSync(file, { force: true });
    await fire('session_start', {});
  }
});

test('writing view: an editor that cannot come back beside a quitting Pi stays whole, findable and still marked', async () => {
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const docs = [join(dir, 'stuck-a.md'), join(dir, 'stuck-b.md')];
  for (const file of docs) writeFileSync(file, '# stuck\n');
  const piWindow = tmux('display-message', '-p', '-t', owner, '#{window_id}');
  try {
    await fire('session_start', {});
    for (const file of docs) await extension.commands.get('edit').handler(file, context);
    const { window } = await lib.setWriting(owner, true);
    const [doc] = docPanes(owner);
    assert.equal(tmux('display-message', '-p', '-t', doc, '#{window_id}'), window);
    tmux('send-keys', '-t', doc, 'G', 'o', 'stuck unsaved', 'Escape');
    await waitFor(() => screen(doc).includes('stuck unsaved'), 'unsaved text typed');
    // Too narrow for a second pane: join-pane fails.
    tmux('resize-window', '-t', piWindow, '-x', '2');
    await fire('session_shutdown', { reason: 'quit' });
    assert.deepEqual(docPanes(owner), [doc], 'the editor keeps its unsaved text');
    assert.equal(tmux('display-message', '-p', '-t', doc, '#{window_id}'), window, 'in its own window');
    assert.equal(tmux('show-options', '-wqv', '-t', window, '@pi_preview_window'), '', 'listed in the Windows row');
    assert.equal(tmux('show-options', '-wqv', '-t', window, '@pi_panels'), '', 'with no row of the Pi that left');
    assert.equal(tmux('show-options', '-pqv', '-t', doc, '@pi_writing'), '1', 'still a writing view, both sides');
    assert.equal(execFileSync('nvim', ['--clean', '--server', tmux('show-options', '-pqv', '-t', doc, '@pi_doc_server'), '--remote-expr', "len(filter(getwininfo(), 'getwinvar(v:val.winid, \"&winfixbuf\") == 0'))"], { encoding: 'utf8' }).trim(), '2');
  } finally {
    tmux('set-option', '-wu', '-t', piWindow, 'window-size');
    tmux('resize-window', '-t', piWindow, '-x', '240', '-y', '50');
    for (const pane of docPanes(owner)) tmux('kill-pane', '-t', pane);
    tmux('set-option', '-pu', '-t', owner, '@pi_docs');
    for (const file of docs) rmSync(file, { force: true });
    await fire('session_start', {});
  }
});

// A second Pi in its own window: the extension loaded with that pane as TMUX_PANE, on `session`. The
// pane runs `command`, standing for the process Pi runs in.
async function otherPi(session, command = 'sleep 100000') {
  const pane = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-c', repo, command);
  const before = process.env.TMUX_PANE;
  process.env.TMUX_PANE = pane;
  try {
    const ext = await load();
    const ctx = { ...context, sessionManager: { getSessionId: () => session } };
    await fire('session_start', { reason: 'startup' }, ctx, ext);
    await fire('before_agent_start', {}, ctx, ext);
    return { pane, ext, ctx };
  } finally { process.env.TMUX_PANE = before; }
}
// A process id no process has now.
function deadPid() {
  return Number(execFileSync('sh', ['-c', 'sleep 0 & echo $!; wait'], { encoding: 'utf8' }).trim());
}
// As if the Pi recorded in `pane` had died, leaving the process that started it running the pane.
const piDied = pane => tmux('set-option', '-p', '-t', pane, '@pi_pid', `${deadPid()} ${tmux('display-message', '-p', '-t', pane, '#{pane_pid}')}`);

test('a restarted Pi adopts its session\'s editor and Hunk instead of opening new ones, keeping unsaved text and documents', async () => {
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const names = ['one', 'two', 'three'], files = names.map(name => join(dir, `restart-${name}.md`));
  names.forEach((name, i) => writeFileSync(files[i], `# ${name}\n\n${name} body\n`));
  // The editor's current buffer, read from Neovim rather than the screen, which wraps in a narrow pane.
  const shows = (pane, text) => execFileSync('nvim', ['--clean', '--server', tmux('show-options', '-pqv', '-t', pane, '@pi_doc_server'),
    '--remote-expr', "join(getline(1, '$'), \"\\n\")"], { encoding: 'utf8' }).includes(text);
  const row = pane => tmux('show-options', '-pqv', '-t', pane, '@pi_panels');
  const created = [];
  try {
    const a = await otherPi('session-restart');
    created.push(a.pane);
    await a.ext.commands.get('edit').handler(files[0], a.ctx);
    await a.ext.commands.get('edit').handler(files[1], a.ctx);
    await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'restart code\n'), a.ctx, a.ext, { path: 'tracked.txt' });
    // An agent turn writing two documents: both get tabs, but the editor (with unsaved text) loads
    // neither as its current buffer, and the older one is never loaded at all.
    const [editor] = docPanes(a.pane), [hunk] = diffPanes(a.pane);
    assert.ok(editor && hunk, 'the first Pi has an editor and a Hunk');
    await waitFor(() => shows(editor, 'two body'), 'the editor shows the second document');
    tmux('send-keys', '-t', editor, 'G', 'o', 'unsaved before restart', 'Escape');
    await waitFor(() => shows(editor, 'unsaved before restart'), 'unsaved text typed');
    const agentDocs = ['agent-a.md', 'agent-b.md'].map(name => join(repo, name));
    await tool('write', () => {
      writeFileSync(agentDocs[0], '# a\n');
      utimesSync(agentDocs[0], new Date(Date.now() - 60000), new Date(Date.now() - 60000));
      writeFileSync(agentDocs[1], '# b\n');
    }, a.ctx, a.ext, { path: 'agent-b.md' });
    const loaded = () => execFileSync('nvim', ['--clean', '--server', tmux('show-options', '-pqv', '-t', editor, '@pi_doc_server'),
      '--remote-expr', "join(map(getbufinfo({'buflisted': 1}), 'v:val.name'), \"\\n\")"], { encoding: 'utf8' });
    assert.ok(!loaded().includes('agent-a.md'), 'the older agent document has a tab but no buffer');

    // The Pi's pane is killed; its session is resumed in another window.
    tmux('kill-pane', '-t', a.pane);
    const b = await otherPi('session-restart');
    created.push(b.pane);
    assert.deepEqual(docPanes(b.pane), [editor], 'the new Pi owns the surviving editor');
    assert.deepEqual(diffPanes(b.pane), [hunk], 'and the surviving Hunk');
    assert.deepEqual((await lib.documents(b.pane)).sort(), [...files.slice(0, 2), ...agentDocs].map(file => realpathSync(file)).sort(),
      'all its documents came with it, including one never loaded in the editor');
    assert.ok(shows(editor, 'unsaved before restart'), 'unsaved text is kept');
    await waitFor(() => /restart-one\.md.*restart-two\.md ●/.test(row(b.pane)), 'the new Pi\'s row has both tabs, one unsaved');

    // Later changes use the adopted editor; its own refreshes reach the new Pi's row.
    await b.ext.commands.get('edit').handler(files[2], b.ctx);
    assert.deepEqual(panes('@pi_doc_owner').filter(([, tag]) => tag).map(([id]) => id), [editor], 'still one editor');
    await waitFor(() => shows(editor, 'three body'), 'it shows the new document');
    await waitFor(() => row(b.pane).includes('restart-three.md'), 'with its tab');
    tmux('send-keys', '-t', editor, 'G', 'o', 'more', 'Escape');
    await waitFor(() => /restart-three\.md ●/.test(row(b.pane)), 'the editor\'s own refresh redraws the new owner\'s row');
  } finally {
    for (const pane of [...panes('@pi_doc_owner'), ...panes()].filter(([, tag]) => created.includes(tag)).map(([id]) => id)) tmux('kill-pane', '-t', pane);
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
    git('checkout', 'tracked.txt');
    for (const name of ['agent-a.md', 'agent-b.md']) rmSync(join(repo, name), { force: true });
  }
});

test('adoption takes only a dead Pi\'s previews of the same session: live Pis, other sessions and untagged editors are left alone', async () => {
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const file = join(dir, 'shared.md');
  writeFileSync(file, '# shared\n');
  const created = [];
  const editorOf = pane => docPanes(pane)[0];
  try {
    // Same session, opened twice, both running: each keeps its own editor.
    const a = await otherPi('session-shared');
    created.push(a.pane);
    await a.ext.commands.get('edit').handler(file, a.ctx);
    const editorA = editorOf(a.pane);
    const b = await otherPi('session-shared');
    created.push(b.pane);
    assert.equal(editorOf(a.pane), editorA, 'a live Pi\'s editor is not taken');
    assert.equal(editorOf(b.pane), undefined);
    await b.ext.commands.get('edit').handler(file, b.ctx);
    assert.ok(editorOf(b.pane) && editorOf(b.pane) !== editorA, 'the second Pi opens its own');

    // The Pi in pane A died but its shell pane survived: its recorded process is gone.
    piDied(a.pane);
    tmux('kill-pane', '-t', editorOf(b.pane));
    const c = await otherPi('session-shared');
    created.push(c.pane);
    assert.equal(editorOf(c.pane), editorA, 'a dead Pi\'s editor is adopted though its pane survives');
    assert.equal(editorOf(a.pane), undefined);

    // Another session does not take it, even from a dead Pi; nor does anyone take an untagged editor.
    piDied(c.pane);
    const d = await otherPi('session-other');
    created.push(d.pane);
    assert.equal(editorOf(c.pane), editorA, 'another session leaves it');
    tmux('set-option', '-pu', '-t', editorA, '@pi_session');
    const e = await otherPi('session-shared');
    created.push(e.pane);
    assert.equal(editorOf(c.pane), editorA, 'an editor without a session is never adopted');
    tmux('set-option', '-p', '-t', editorA, '@pi_session', 'session-shared');

    // A replacement Pi in that pane, its claim still waiting for a lock, has already recorded itself:
    // another claim of the old session leaves the pane's editor alone.
    const holderPane = c.pane;
    let release;
    const blocking = lib.withDocuments(holderPane, () => new Promise(done => { release = done; }));
    await waitFor(() => release, 'the lock is held');
    const replacement = lib.claimSession(holderPane, 'session-replacement', { pid: process.pid });
    await sleep(300);
    const racing = await lib.claimSession(tmux('new-window', '-d', '-P', '-F', '#{pane_id}', 'sleep 100000'), 'session-shared', { pid: process.pid });
    release();
    await Promise.all([blocking, replacement]);
    assert.deepEqual(racing.adopted, [], 'the replacement Pi keeps the editor that follows its pane');
    assert.equal(editorOf(holderPane), editorA);
    piDied(holderPane);
    tmux('set-option', '-p', '-t', editorA, '@pi_session', 'session-shared');

    // The pane was respawned with another program: its recorded Pi is dead, but what runs there now is
    // not what started it, so the editor is not taken.
    tmux('respawn-pane', '-k', '-t', holderPane, 'sleep 100000');
    const respawned = await lib.claimSession(tmux('new-window', '-d', '-P', '-F', '#{pane_id}', 'sleep 100000'), 'session-shared', { pid: process.pid });
    assert.deepEqual(respawned.adopted, [], 'a respawned pane keeps its editor');
    assert.deepEqual(respawned.unclear.map(editor => editor.id), [editorA], 'and the claim reports it as unclear');
    piDied(holderPane);

    // Two Pis resuming at once: exactly one adopts.
    const [f, g] = ['f', 'g'].map(() => tmux('new-window', '-d', '-P', '-F', '#{pane_id}', 'sleep 100000'));
    created.push(f, g);
    const claims = await Promise.all([f, g].map(pane => lib.claimSession(pane, 'session-shared', { pid: process.pid })));
    assert.deepEqual(claims.map(claim => claim.adopted.length).sort(), [0, 1], 'one claim adopts it, the other finds it taken');
    const holder = tmux('show-options', '-pqv', '-t', editorA, '@pi_doc_owner');
    assert.ok([f, g].includes(holder));

    // An editor that does not answer is still taken over, so none opens beside it, and Pi says so.
    piDied(holder);
    const server = tmux('show-options', '-pqv', '-t', editorA, '@pi_doc_server');
    tmux('set-option', '-p', '-t', editorA, '@pi_doc_server', join(dir, 'no-such.sock'));
    notices = [];
    const h = await otherPi('session-shared');
    created.push(h.pane);
    assert.equal(editorOf(h.pane), editorA, 'the silent editor is kept and taken over');
    assert.ok(notices.some(text => text.includes('not answering')), 'Pi warns that it does not answer');
    await h.ext.commands.get('edit').handler(file, h.ctx);
    assert.deepEqual(docPanes(h.pane), [editorA], 'no second editor opens beside it');
    tmux('set-option', '-p', '-t', editorA, '@pi_doc_server', server);
  } finally {
    for (const [id, tag] of panes('@pi_doc_owner')) if (created.includes(tag)) tmux('kill-pane', '-t', id);
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
  }
});

test('an editor whose Pi may still run is not taken, and none opens automatically beside it; another kept editor is reported', async () => {
  const file = join(dir, 'unclear.md');
  writeFileSync(file, '# unclear\n');
  const created = [];
  try {
    // A Pi typed into an interactive shell; it dies, and the shell then runs something else.
    const x = await otherPi('session-unclear', 'sh -i');
    created.push(x.pane);
    await x.ext.commands.get('edit').handler(file, x.ctx);
    const [editor] = docPanes(x.pane);
    piDied(x.pane);
    // Without job control the program shares the shell's process group, which is then in the foreground.
    tmux('send-keys', '-t', x.pane, 'set +m; sleep 1000', 'Enter');
    await sleep(500);
    notices = [];
    const y = await otherPi('session-unclear');
    created.push(y.pane);
    assert.deepEqual(docPanes(x.pane), [editor], 'the editor is not taken');
    assert.ok(notices.some(text => text.includes('not taken over')), 'Pi says why');
    await tool('write', () => writeFileSync(join(repo, 'unclear-agent.md'), '# agent\n'), y.ctx, y.ext, { path: 'unclear-agent.md' });
    assert.deepEqual(docPanes(y.pane), [], 'an agent change does not open a competing editor');
    assert.ok(tmux('show-options', '-pqv', '-t', y.pane, '@pi_docs').includes('unclear-agent.md'), 'its document still gets a tab');
    // A third Pi takes the editor over once its Pi is clearly gone; agent changes in y open editors again.
    tmux('send-keys', '-t', x.pane, 'C-c', '');
    await sleep(500);
    const z = await otherPi('session-unclear');
    created.push(z.pane);
    assert.deepEqual(docPanes(z.pane), [editor], 'the idle shell lets the next Pi take it over');
    await tool('write', () => writeFileSync(join(repo, 'unclear-agent.md'), '# agent again\n'), y.ctx, y.ext, { path: 'unclear-agent.md' });
    assert.equal(docPanes(y.pane).length, 1, 'y is no longer held back by an editor another Pi now owns');

    // z's Pi dies too; y, which now has an editor of its own, keeps it and says the other remains.
    piDied(z.pane);
    notices = [];
    await fire('session_start', { reason: 'reload' }, y.ctx, y.ext);
    assert.deepEqual(docPanes(z.pane), [editor], 'the other editor is left where it is');
    assert.ok(notices.some(text => text.includes('still open in its own pane')), 'and reported');
  } finally {
    for (const [id, tag] of panes('@pi_doc_owner')) if (created.includes(tag)) tmux('kill-pane', '-t', id);
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
    rmSync(join(repo, 'unclear-agent.md'), { force: true });
  }
});

test('Pi quitting with unsaved text and restarting in the same pane gets its document tabs back', async () => {
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const files = ['kept-one', 'kept-two'].map(name => join(dir, `${name}.md`));
  for (const file of files) writeFileSync(file, '# kept\n');
  const created = [];
  try {
    const a = await otherPi('session-quit');
    created.push(a.pane);
    for (const file of files) await a.ext.commands.get('edit').handler(file, a.ctx);
    const [editor] = docPanes(a.pane);
    tmux('send-keys', '-t', editor, 'G', 'o', 'unsaved at quit', 'Escape');
    await waitFor(() => tmux('capture-pane', '-p', '-t', editor).includes('unsaved at quit'), 'unsaved text typed');
    await fire('session_shutdown', { reason: 'quit' }, a.ctx, a.ext);
    assert.deepEqual(docPanes(a.pane), [editor], 'the editor stays for its unsaved text');
    assert.deepEqual(await lib.documents(a.pane), [], 'quitting clears Pi\'s list');
    // Pi starts again in the same pane, on the same session.
    const before = process.env.TMUX_PANE;
    process.env.TMUX_PANE = a.pane;
    const again = await load().finally(() => { process.env.TMUX_PANE = before; });
    await fire('session_start', { reason: 'startup' }, a.ctx, again);
    assert.deepEqual((await lib.documents(a.pane)).sort(), files.map(file => realpathSync(file)).sort(), 'both tabs are back');
  } finally {
    for (const [id, tag] of panes('@pi_doc_owner')) if (created.includes(tag)) tmux('kill-pane', '-t', id);
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
  }
});

test('a Pi that goes without quitting leaves its previews, saved or not, as ordinary windows for a resume to adopt', async () => {
  tmux('source-file', join(root, 'tmux/pi-tabs.conf'));  // the hooks, as installed
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const files = ['gone-one', 'gone-two', 'gone-crash', 'gone-live', 'gone-window', 'gone-signal', 'gone-shell', 'gone-replaced'].map(name => join(dir, `${name}.md`));
  for (const file of files) writeFileSync(file, `# ${basename(file)}\n`);
  const created = [];
  const alive = id => panes().some(([pane]) => pane === id);
  const hidden = pane => tmux('show-options', '-wqv', '-t', pane, '@pi_preview_window');
  const row = pane => tmux('show-options', '-pqv', '-t', pane, '@pi_panels');
  const windowOf = pane => tmux('display-message', '-p', '-t', pane, '#{window_id}');
  const code = (pi, line) => tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), `${line}\n`), pi.ctx, pi.ext, { path: 'tracked.txt' });
  // A Pi with a saved editor and a Hunk, one of them waiting in a hidden window.
  async function withPreviews(session, documents, command) {
    const pi = await otherPi(session, command);
    created.push(pi.pane);
    for (const file of documents) await pi.ext.commands.get('edit').handler(file, pi.ctx);
    await code(pi, session);
    const [editor] = docPanes(pi.pane), [hunk] = diffPanes(pi.pane);
    assert.ok(editor && hunk, `${session}: an editor and a Hunk`);
    assert.equal(hidden(editor), '1', `${session}: the saved editor waits in a hidden window, the diff beside Pi`);
    return { ...pi, editor, hunk };
  }
  // The tab helper, run as tmux runs it: asynchronously, since this process's Pis may hold a lock it waits for.
  const helper = (...args) => promisify(execFile)(process.execPath, ['--no-warnings', join(root, 'scripts/tmux-tabs.mjs'), ...args]);
  const released = ({ editor, hunk }) => [editor, hunk].every(pane => alive(pane) && !hidden(pane) && !row(pane));
  try {
    // Killed pane: Pi is then told to quit (as SIGHUP does) after its pane has gone.
    const killed = await withPreviews('gone-killed', files.slice(0, 2));
    notices.length = 0;
    tmux('kill-pane', '-t', killed.pane);
    await fire('session_shutdown', { reason: 'quit' }, killed.ctx, killed.ext);
    assert.deepEqual(notices, [], 'quitting after the pane has gone reports no failure');
    await waitFor(() => released(killed), 'the saved editor and the Hunk keep running, shown as ordinary windows without its row');
    assert.equal(tmux('show-options', '-pqv', '-t', killed.editor, '@pi_session'), 'gone-killed', 'still tagged with their session');
    // Typing there refreshes its row (the editor's autocmds); that brings back no row of the gone Pi.
    tmux('send-keys', '-t', killed.editor, 'G', 'o', 'typed after Pi went', 'Escape');
    await waitFor(() => screen(killed.editor).includes('typed after Pi went'), 'typed in the left editor');
    await sleep(1500);
    assert.equal(row(killed.editor), '', 'no row for a gone Pi');

    // A Pi that dies without quitting: its pane exits (the hook releases its previews).
    const crashed = await withPreviews('gone-crash', [files[2]], 'cat');
    tmux('send-keys', '-t', crashed.pane, 'C-d');
    await waitFor(() => !alive(crashed.pane) && released(crashed), 'a pane that exits leaves its previews the same way');

    // A signal stopping a Pi whose pane stays (kill <pid>): it quits as for /quit, but leaves its previews.
    const listening = process.listeners('SIGTERM');
    const signalled = await withPreviews('gone-signal', [files[5]]);
    const added = process.listeners('SIGTERM').filter(listener => !listening.includes(listener));
    assert.equal(added.length, 1, 'the Pi listens for SIGTERM');
    added[0]('SIGTERM');   // that listener alone: the test process receives no signal
    await fire('session_shutdown', { reason: 'quit' }, signalled.ctx, signalled.ext);
    await waitFor(() => released(signalled), 'its previews stay, as ordinary windows, though its pane is still there');
    assert.deepEqual([tmux('show-options', '-pqv', '-t', signalled.pane, '@pi_owner'), row(signalled.pane)], ['', ''],
      'and its pane is no longer marked as a Pi, nor shows its row');
    // Before Pi has exited (its process, recorded there, still runs), typing in the left editor redraws no row of it.
    tmux('send-keys', '-t', signalled.editor, 'G', 'o', 'typed after the signal', 'Escape');
    await waitFor(() => screen(signalled.editor).includes('typed after the signal'), 'typed');
    await sleep(1500);
    assert.ok(released(signalled) && !row(signalled.pane), 'still released while the leaving process runs');

    // A Pi that dies in a shell, which stays: the next sweep (any pane closing) releases its previews.
    const shell = await withPreviews('gone-shell', [files[6]]);
    piDied(shell.pane);
    await helper('sweep');
    assert.ok(released(shell) && !row(shell.pane), 'released by the sweep, with no row left on the shell\'s pane');

    // A leaving Pi's release applies only while it is the Pi recorded in its pane: a new Pi there keeps its previews.
    const replaced = await withPreviews('gone-replaced', [files[7]]);
    const stale = deadPid();   // the leaving Pi; the pane now records this (live) test process
    await lib.releaseOrphans({ leaving: { pane: replaced.pane, pid: stale } });
    assert.ok(hidden(replaced.editor) === '1' && row(replaced.editor) && tmux('show-options', '-pqv', '-t', replaced.pane, '@pi_owner') === '1',
      'the new Pi\'s previews and marks are untouched');
    await lib.releaseOrphans({ leaving: { pane: replaced.pane, pid: process.pid } });
    await waitFor(() => released(replaced), 'the Pi recorded there is released when it leaves');

    // A live Pi's previews are untouched.
    const live = await withPreviews('gone-live', [files[3]]);
    assert.ok(hidden(live.editor) === '1' && row(live.editor), 'a live Pi keeps its hidden preview and its row');

    // Closing a Pi's window from its tab: an editor there with unsaved text moves to its own window, and
    // the previews elsewhere are released.
    const closing = await withPreviews('gone-window', [files[4]]);
    await closing.ext.commands.get('panel').handler('edit', closing.ctx);
    tmux('send-keys', '-t', closing.editor, 'G', 'o', 'unsaved in a closing window', 'Escape');
    await waitFor(() => screen(closing.editor).includes('unsaved in a closing window'), 'unsaved text typed');
    const client = tmux('list-clients', '-F', '#{client_name}').split('\n')[0] ?? '';
    await helper('kill-window', windowOf(closing.pane), client);
    await waitFor(() => !alive(closing.pane) && released(closing), 'the editor (moved out) and the Hunk remain as ordinary windows');
    assert.ok(screen(closing.editor).includes('unsaved in a closing window'), 'with its unsaved text');

    // Resuming the killed Pi's session elsewhere takes both previews back, with every document tab.
    const resumed = await otherPi('gone-killed');
    created.push(resumed.pane);
    assert.deepEqual([docPanes(resumed.pane), diffPanes(resumed.pane)], [[killed.editor], [killed.hunk]], 'adopted, not reopened');
    assert.deepEqual((await lib.documents(resumed.pane)).sort(), files.slice(0, 2).map(file => realpathSync(file)).sort(), 'with its document tabs');
    await waitFor(() => [killed.editor, killed.hunk].filter(pane => windowOf(pane) !== windowOf(resumed.pane)).every(pane => hidden(pane) === '1'),
      'the one not beside the resumed Pi waits hidden again');
  } finally {
    for (const [id, tag] of [...panes('@pi_doc_owner'), ...panes()]) if (created.includes(tag)) try { tmux('kill-pane', '-t', id); } catch {}
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
    git('checkout', 'tracked.txt');
  }
});

test('an agent change shows its diff in place of a saved editor; unsaved text, named or unnamed, keeps the editor beside Pi', async () => {
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const file = join(dir, 'state-saved.md');
  writeFileSync(file, '# saved state\n');
  const created = [];
  try {
    const pi = await otherPi('editor-state');
    created.push(pi.pane);
    const beside = () => tmux('list-panes', '-t', pi.pane, '-F', '#{pane_id}').split('\n').filter(id => id !== pi.pane);
    const state = pane => lib.editorState(execFileSync('sh', ['-c', 'command -v nvim'], { encoding: 'utf8' }).trim(), pane);
    const code = line => tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), `${line}\n`), pi.ctx, pi.ext, { path: 'tracked.txt' });
    await pi.ext.commands.get('edit').handler(file, pi.ctx);
    const [doc] = docPanes(pi.pane);
    assert.ok(await screenContains(doc, 'saved state'));
    // The editor's command index is a scratch buffer of its own: it is not unsaved text.
    assert.deepEqual(await state(doc), { current: realpathSync(file), shown: new Set([realpathSync(file)]), unsaved: new Set(), modified: 0 }, 'a saved editor has nothing unsaved');

    await code('beside a saved editor');
    const [diff] = diffPanes(pi.pane);
    assert.deepEqual(beside(), [diff], 'the diff takes the place of a saved editor');

    await pi.ext.commands.get('panel').handler('edit', pi.ctx);
    assert.deepEqual(beside(), [doc]);
    tmux('send-keys', '-t', doc, 'G', 'o', 'named draft', 'Escape');
    await waitFor(() => screen(doc).includes('named draft'), 'named text typed');
    assert.deepEqual([...(await state(doc)).unsaved], [realpathSync(file)], 'a modified document is unsaved');
    await code('beside named text');
    assert.deepEqual(beside(), [doc], 'unsaved document text keeps the editor beside Pi');

    tmux('send-keys', '-t', doc, ':e!', 'Enter', ':enew', 'Enter', 'i', 'unnamed draft', 'Escape');
    await waitFor(() => screen(doc).includes('unnamed draft'), 'unnamed text typed');
    assert.deepEqual(await state(doc), { current: '', shown: new Set(), unsaved: new Set(), modified: 1 }, 'text in an unnamed buffer is unsaved');
    await code('beside unnamed text');
    assert.deepEqual(beside(), [doc], 'unnamed unsaved text keeps the editor beside Pi');
  } finally {
    for (const [id, tag] of [...panes('@pi_doc_owner'), ...panes()]) if (created.includes(tag)) try { tmux('kill-pane', '-t', id); } catch {}
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
    git('checkout', 'tracked.txt');
  }
});

test('reload keeps the session; a new or resumed session in the same pane keeps the previews, which then belong to it', async () => {
  const file = join(dir, 'switch.md');
  writeFileSync(file, '# switch\n');
  const created = [];
  const session = pane => tmux('show-options', '-pqv', '-t', pane, '@pi_session');
  try {
    const a = await otherPi('session-before');
    created.push(a.pane);
    await a.ext.commands.get('edit').handler(file, a.ctx);
    const [editor] = docPanes(a.pane);
    assert.equal(session(editor), 'session-before', 'the editor carries its Pi\'s session');
    await fire('session_shutdown', { reason: 'reload' }, a.ctx, a.ext);
    await fire('session_start', { reason: 'reload' }, a.ctx, a.ext);
    assert.deepEqual(docPanes(a.pane), [editor]);
    await fire('session_shutdown', { reason: 'resume' }, a.ctx, a.ext);
    const resumed = { ...a.ctx, sessionManager: { getSessionId: () => 'session-after' } };
    await fire('session_start', { reason: 'resume' }, resumed, a.ext);
    assert.deepEqual(docPanes(a.pane), [editor], 'the pane keeps its editor');
    assert.equal(session(editor), 'session-after', 'which now belongs to the resumed session');
    assert.equal(session(a.pane), 'session-after');
  } finally {
    for (const [id, tag] of panes('@pi_doc_owner')) if (created.includes(tag)) tmux('kill-pane', '-t', id);
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
  }
});

test('a document change whose Panels redraw fails still takes effect, warns briefly, and keeps a failed change\'s own error', async () => {
  const client = await tabClient();
  const lib = await import(pathToFileURL(join(root, 'scripts/lib/diff-pane.ts')).href);
  const files = { one: join(dir, 'redraw-one.md'), two: join(dir, 'redraw-two.md') };
  for (const [name, file] of Object.entries(files)) writeFileSync(file, `# ${name}\n\n${name} text\n`);
  // A tmux that fails only the redraw's own write marking Pi's pane; every other call goes through.
  const shim = join(dir, 'failing-redraw');
  mkdirSync(shim, { recursive: true });
  const next = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shim, 'tmux'), `#!/bin/sh\ncase "$*" in "set-option -p -t "*" @pi_owner 1") echo injected >&2; exit 1;; esac\nexec '${next}' "$@"\n`);
  chmodSync(join(shim, 'tmux'), 0o755);
  const path = process.env.PATH, failing = `${shim}:${path}`;
  const helperEnv = { ...process.env, PATH: failing };
  const clientName = tmux('list-clients', '-F', '#{client_name}').split('\n')[0];
  const helper = (...args) => execFileSync(process.execPath, ['--no-warnings', join(root, 'scripts/tmux-tabs.mjs'), ...args], { env: helperEnv });
  const shows = text => tmux('capture-pane', '-p', '-t', docPanes(owner)[0]).includes(text);
  const warned = () => notices.filter(text => text === lib.NOT_REDRAWN).length;
  try {
    await fire('before_agent_start', {});
    await extension.commands.get('edit').handler(files.one, context);
    const before = warned();

    // Pi: /edit while redraws fail shows the document and warns once, through Pi's notices.
    process.env.PATH = failing;
    await extension.commands.get('edit').handler(files.two, context);
    process.env.PATH = path;
    await waitFor(() => shows('two text'), '/edit shows the document');
    assert.equal(warned(), before + 1, 'Pi warns that the Panels bar could not refresh');
    assert.ok(!notices.some(text => text.includes('injected')), 'no raw error text in the notice');

    // Click helper: selecting a document still switches the editor; the warning is on the client.
    helper(`ds${owner}:${lib.docId(realpathSync(files.one))}`, clientName);
    await waitFor(() => shows('one text'), 'the click shows the document');
    await waitFor(() => client.screen().includes('Panels bar could not refresh'), 'the client sees the warning');

    // Discard and close: the document closes, and the message names the result and the warning.
    tmux('send-keys', '-t', docPanes(owner)[0], 'G', 'o', 'discard me', 'Escape');
    await waitFor(() => shows('discard me'), 'unsaved text typed');
    helper('close-file', owner, Buffer.from(realpathSync(files.one)).toString('hex'), 'discard', clientName);
    await waitFor(() => /Discarded redraw-one\.md\. Document updated, but the Panels bar could not refresh\./.test(client.screen()), 'result and warning shown together');
    assert.ok(!(await lib.documents(owner)).includes(realpathSync(files.one)), 'the document closed');
    assert.ok(!disk(files.one).includes('discard me'), 'discarded text was not written');

    // A change that fails keeps its own error, even when its redraw also fails.
    const editor = docPanes(owner)[0];
    const server = tmux('show-options', '-pqv', '-t', editor, '@pi_doc_server');
    tmux('set-option', '-p', '-t', editor, '@pi_doc_server', join(dir, 'no-such.sock'));
    process.env.PATH = failing;
    await assert.rejects(lib.selectDocument(owner, files.one), error => /nvim/.test(String(error.cmd ?? error.message)) && !String(error.message).includes('Panels'));
    process.env.PATH = path;
    tmux('set-option', '-p', '-t', editor, '@pi_doc_server', server);

    // An agent change: the document opens and Pi warns once when the turn's redraw fails.
    const warnedBefore = warned();
    process.env.PATH = failing;
    await tool('write', () => writeFileSync(join(repo, 'redraw-agent.md'), '# agent\n'), context, extension, { path: 'redraw-agent.md' });
    process.env.PATH = path;
    assert.equal(warned(), warnedBefore + 1, 'the agent change warns once');
    assert.ok((await lib.documents(owner)).includes(realpathSync(join(repo, 'redraw-agent.md'))), 'the agent document has its tab entry');
    // A code-only change is not a document change: no document warning.
    process.env.PATH = failing;
    await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'redraw code\n'), context, extension, { path: 'tracked.txt' });
    process.env.PATH = path;
    assert.equal(warned(), warnedBefore + 1, 'no warning for a code-only change');

    // With redraws working again, the row recovers.
    await lib.renderPanels(owner);
    assert.ok(tmux('show-options', '-pqv', '-t', owner, '@pi_panels').includes('redraw-agent.md'), 'the next redraw shows it');
  } finally {
    process.env.PATH = path;
    for (const pane of docPanes(owner)) tmux('kill-pane', '-t', pane);
    tmux('set-option', '-pu', '-t', owner, '@pi_docs');
    rmSync(join(repo, 'redraw-agent.md'), { force: true });
    git('checkout', 'tracked.txt');
    client.close();
  }
});

test('Playwright snapshots (.playwright-cli, at any depth) open no diff, and Hunk leaves them out', async () => {
  const snapshots = [join(repo, '.playwright-cli'), join(repo, 'sub', '.playwright-cli')];
  const created = [];
  try {
    const pi = await otherPi('playwright');
    created.push(pi.pane);
    await tool('bash', () => {
      for (const folder of snapshots) { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'page.yml'), 'snapshot\n'); }
    }, pi.ctx, pi.ext);
    assert.deepEqual(diffPanes(pi.pane), [], 'a turn writing only snapshots opens nothing');
    await tool('edit', () => appendFileSync(join(repo, 'tracked.txt'), 'real change\n'), pi.ctx, pi.ext, { path: 'tracked.txt' });
    const [hunk] = diffPanes(pi.pane);
    assert.ok(hunk, 'a real change opens Hunk');
    assert.ok(await screenContains(hunk, 'tracked.txt'), 'showing the change');
    assert.ok(!screen(hunk).includes('page.yml'), `but not the snapshots:\n${screen(hunk)}`);
  } finally {
    for (const [id, tag] of panes()) if (created.includes(tag)) try { tmux('kill-pane', '-t', id); } catch {}
    for (const pane of created) try { tmux('kill-pane', '-t', pane); } catch {}
    for (const folder of snapshots) rmSync(folder, { recursive: true, force: true });
    rmSync(join(repo, 'sub'), { recursive: true, force: true });
    git('checkout', 'tracked.txt');
  }
});

test('a worktree the session chooses with /panel or show_panel, or edits in, is watched and listed like its repository, across reload, until removed; commands and other processes associate none', async () => {
  const modules = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
  const { loadExtensions, createExtensionRuntime } = await import(pathToFileURL(join(modules, '@earendil-works/pi-coding-agent/dist/core/extensions/loader.js')).href);
  const worktree = join(dir, 'spawned-wt'), other = join(dir, 'other-wt'), shared = join(dir, 'shared-wt');
  const pane = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-c', repo, 'sleep 100000');
  // One Pi runtime on a session whose custom entries live in `saved`.
  async function start(saved, reason = 'startup') {
    const runtime = createExtensionRuntime();
    runtime.appendEntry = (customType, data) => saved.push({ type: 'custom', customType, data });
    const before = process.env.TMUX_PANE;
    process.env.TMUX_PANE = pane;
    try {
      const result = await loadExtensions([join(root, 'pi/extensions/diff-pane.ts')], root, undefined, runtime);
      assert.deepEqual(result.errors, []);
      const ext = result.extensions[0];
      const ctx = { ...context, sessionManager: { getSessionId: () => 'spawner', getEntries: () => saved } };
      await fire('session_start', { reason }, ctx, ext);
      await fire('before_agent_start', {}, ctx, ext);
      return { ext, ctx };
    } finally { process.env.TMUX_PANE = before; }
  }
  // What /panels offers, as its selector draws it.
  async function offered({ ext, ctx }) {
    let drawn = '';
    const ui = { ...ctx.ui, custom: factory => new Promise(resolve => {
      drawn = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: text => text }, undefined, resolve).render(200).join('\n');
      resolve(undefined);
    }) };
    await ext.commands.get('panels').handler('', { ...ctx, ui });
    return drawn;
  }
  const diffOf = path => diffPanes(pane).filter(id => tmux('show-options', '-pqv', '-t', id, '@pi_diff_root') === realpathSync(path));
  const recorded = path => ({ type: 'custom', customType: 'harness-session-worktree', data: { root: realpathSync(path) } });
  const nested = join(dir, 'nested'), twin = join(nested, 'spawned-wt');   // the same folder name, elsewhere
  const panel = async (pi, name) => { const shown = []; await pi.ext.commands.get('panel').handler(name, { ...pi.ctx, ui: { ...pi.ctx.ui, notify: text => shown.push(text) } }); return shown[0]; };
  try {
    const saved = [];
    const first = await start(saved);
    assert.ok(!(await offered(first)).includes('spawned-wt'));
    // While this session's command merely names a worktree, another process creates one of that name: not this session's.
    await tool('bash', () => git('worktree', 'add', '-q', '--detach', shared, 'HEAD'), first.ctx, first.ext,
      { command: `echo 'git worktree add ${shared}'` });
    await tool('bash', () => git('worktree', 'add', '-q', '--detach', other, 'HEAD'), first.ctx, first.ext, { command: 'echo unrelated' });
    // Nor is one the session's own command makes: commands are not read.
    await tool('bash', () => git('worktree', 'add', '-q', '-b', 'spawned', worktree), first.ctx, first.ext,
      { command: `git worktree add -q -b spawned ${worktree}` });
    mkdirSync(nested);
    git('worktree', 'add', '-q', '--detach', twin, 'HEAD');
    assert.deepEqual(saved, [], 'no worktree is recorded from a command or from appearing in the list');
    assert.ok(!/(shared|other|spawned)-wt/.test(await offered(first)), 'nor listed');
    await tool('bash', () => appendFileSync(join(shared, 'tracked.txt'), 'another process\'s edit\n'), first.ctx, first.ext, { command: 'true' });
    assert.deepEqual(diffOf(shared), [], 'nor watched');
    git('-C', shared, 'checkout', 'tracked.txt');

    // Choosing it explicitly by its top-level folder makes it the session's.
    mkdirSync(join(worktree, 'sub'));
    assert.match(await panel(first, join(worktree, 'sub')), /not the top-level folder of a Git worktree/, 'a folder inside it is refused');
    assert.match(await panel(first, '../spawned-wt'), /Watching .*spawned-wt for this session; it has no changes/, 'relative to Pi\'s directory');
    assert.deepEqual(saved, [recorded(worktree)], 'recorded in the session');
    const listed = await offered(first);
    assert.match(listed, /spawned-wt · no changes/, '/panels lists it');
    assert.equal(listed.match(/spawned-wt · /g).length, 1, 'only that one, not the other folder of its name');
    // The session's later changes there open its diff beside Pi, as for its repository.
    const edited = join(worktree, 'tracked.txt');
    await tool('bash', () => appendFileSync(edited, 'session edit in its worktree\n'), first.ctx, first.ext, { command: 'sh build.sh' });
    const opened = diffOf(worktree);
    assert.equal(opened.length, 1, 'the chosen worktree\'s diff opens');
    assert.ok(await screenContains(opened[0], 'session edit in its worktree'), 'showing the edit');
    assert.deepEqual(diffOf(twin), [], 'the same-named folder is not watched');
    tmux('kill-pane', '-t', opened[0]);
    // /panel (and show_panel) open it by its folder name now that it is listed.
    assert.equal(await panel(first, 'spawned-wt'), 'Showing the spawned-wt diff.');
    tmux('kill-pane', '-t', diffOf(worktree)[0]);
    assert.match(await offered(first), /spawned-wt · 1 changed/, '/panels offers its diff');
    // The agent selects one through show_panel, as the tool's description asks.
    const tool_ = first.ext.tools.get('show_panel');
    const result = await tool_.definition.execute('call-show', { name: other }, undefined, undefined, first.ctx);
    assert.match(result.content[0].text, /Watching .*other-wt for this session/);
    assert.deepEqual(saved, [recorded(worktree), recorded(other)], 'a show_panel choice is recorded too');

    // A reload or resume reads the session; a new session starts without it.
    assert.match(await offered(await start(saved, 'reload')), /spawned-wt · 1 changed/, 'still offered after a reload');
    assert.ok(!(await offered(await start([], 'new'))).includes('spawned-wt'), 'a new session does not inherit it');
    // The earlier record type took any worktree that appeared during a turn; it is not read.
    const legacy = [{ type: 'custom', customType: 'harness-spawned-worktree', data: { root: realpathSync(shared) } }];
    assert.ok(!(await offered(await start(legacy, 'resume'))).includes('shared-wt'), 'an earlier, unproven record is ignored');

    // A write follows a symlink: the worktree where it lands is the one associated, in both directions.
    const linked = [];
    const linking = await start(linked, 'new');
    symlinkSync(join(twin, 'tracked.txt'), join(repo, 'to-twin.txt'));
    symlinkSync(join(repo, 'tracked.txt'), join(shared, 'to-main.txt'));
    await tool('edit', undefined, linking.ctx, linking.ext, { path: join(repo, 'to-twin.txt') });
    await tool('edit', undefined, linking.ctx, linking.ext, { path: join(shared, 'to-main.txt') });
    assert.deepEqual(linked, [recorded(twin)], 'the target\'s worktree, not the link\'s');
    rmSync(join(repo, 'to-twin.txt')); rmSync(join(shared, 'to-main.txt'));

    // Editing a file in another worktree of the repository with its own tools makes it the session's, and shows that edit.
    const elsewhere = [];
    const working = await start(elsewhere, 'new');
    const target = join(shared, 'tracked.txt');
    await tool('edit', () => appendFileSync(target, 'the session works here\n'), working.ctx, working.ext, { path: target });
    assert.deepEqual(elsewhere, [recorded(shared)], 'recorded in that session');
    assert.equal(diffOf(shared).length, 1, 'its diff opens in the same turn');
    assert.ok(await screenContains(diffOf(shared)[0], 'the session works here'));
    tmux('kill-pane', '-t', diffOf(shared)[0]);

    await tool('bash', () => git('worktree', 'remove', '--force', worktree), first.ctx, first.ext, { command: 'git worktree remove --force spawned-wt' });
    assert.ok(!(await offered(await start(saved, 'reload'))).includes('spawned-wt'), 'a removed worktree is no longer offered');
    assert.equal(saved.length, 2, 'nothing more was recorded');
  } finally {
    for (const path of [other, shared, worktree, twin]) try { git('worktree', 'remove', '--force', path); } catch {}
    try { git('branch', '-D', 'spawned'); } catch {}
    for (const [id, tag] of panes()) if (tag === pane) try { tmux('kill-pane', '-t', id); } catch {}
    try { tmux('kill-pane', '-t', pane); } catch {}
  }
});

test('interactive Pi with a scripted model: reads and transient parallel batches open nothing; edits open Hunk, Markdown the editor', async () => {
  const e2e = realpathSync(mkdtempSync(join(tmpdir(), 'diff-pane-tui-')));
  const work = join(e2e, 'repo');
  const socket = `pi-diff-tui-${process.pid}`;
  const t = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await sleep(100); }
    assert.fail(message);
  };
  let socketPath;
  const o = (...args) => execFileSync('tmux', ['-L', `pi-diff-tui-outer-${process.pid}`, ...args], { encoding: 'utf8' }).trim();
  const owned = (tag = '@pi_diff_owner') => t('list-panes', '-a', '-F', `#{pane_id} #{${tag}}`).split('\n').filter(row => /%\d+ %\d+/.test(row));
  try {
    execFileSync('git', ['init', '-q', work]);
    writeFileSync(join(work, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', '.'], { cwd: work });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base'], { cwd: work });
    // Scripted model: a read-only prompt; a parallel batch whose slow call edits and restores a file while the
    // fast call finishes; a bash edit; a Markdown write.
    writeFileSync(join(e2e, 'scripted.ts'), `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
export default function (pi) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted' }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read', { path: 'tracked.txt' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('read done'),
    fauxAssistantMessage([fauxToolCall('bash', { command: 'true' }),
      fauxToolCall('bash', { command: 'echo transient >> tracked.txt; sleep 1; git checkout -q tracked.txt' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('transient done'),
    fauxAssistantMessage(fauxToolCall('bash', { command: 'echo agent-line >> tracked.txt' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('edit done'),
    fauxAssistantMessage(fauxToolCall('write', { path: 'notes.md', content: '# Notes\\n\\nagent notes\\n' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('notes done'),
  ]);
  pi.registerProvider(faux.provider);
}
`);
    // An empty agent directory isolates the run from the user's global Pi configuration.
    // A spare window keeps the server alive after Pi exits.
    t('new-session', '-d', '-s', 'pi', '-x', '220', '-y', '50', '-n', 'spare', 'sleep 120');
    socketPath = t('display-message', '-p', '#{socket_path}');
    t('source-file', join(root, 'tmux/pi-tabs.conf'));  // the bottom rows, as installed
    const pi = t('new-window', '-P', '-F', '#{pane_id}', '-t', 'pi', '-c', work,
      'env', `PI_CODING_AGENT_DIR=${join(e2e, 'agent')}`, 'pi', '--no-session', '--offline', '-ne',
      '-e', join(root, 'pi/extensions/diff-pane.ts'), '-e', join(e2e, 'scripted.ts'), '--provider', 'faux', '--model', 'scripted');
    const screen = pane => t('capture-pane', '-p', '-t', pane);
    await until(() => screen(pi).includes('diff-pane.ts'), 'Pi started with the extension');
    t('send-keys', '-t', pi, 'look', 'Enter');
    await until(() => screen(pi).includes('read done'), 'read prompt finished');
    assert.deepEqual(owned(), [], 'read-only prompt opens nothing');
    t('send-keys', '-t', pi, 'transient', 'Enter');
    await until(() => screen(pi).includes('transient done'), 'parallel prompt finished');
    assert.deepEqual(owned(), [], 'a batch that leaves the tree unchanged opens nothing');
    t('send-keys', '-t', pi, 'change', 'Enter');
    await until(() => screen(pi).includes('edit done'), 'edit prompt finished');
    await until(() => owned().length === 1, 'diff pane opened');
    const diff = owned()[0].split(' ')[0];
    assert.equal(owned()[0], `${diff} ${pi}`);
    assert.equal(t('display-message', '-p', '-t', pi, '#{pane_active}'), '1', 'Pi remains the active pane');
    await until(() => screen(diff).includes('agent-line'), 'Hunk shows the agent change');
    appendFileSync(join(work, 'tracked.txt'), 'external-line\n');
    await until(() => screen(diff).includes('external-line'), 'Hunk refreshes live');
    t('send-keys', '-t', pi, 'notes', 'Enter');
    await until(() => screen(pi).includes('notes done'), 'Markdown prompt finished');
    await until(() => owned('@pi_doc_owner').length === 1, 'editor opened');
    const doc = owned('@pi_doc_owner')[0].split(' ')[0];
    assert.equal(t('display-message', '-p', '-t', pi, '#{pane_active}'), '1', 'Pi remains the active pane');
    await until(() => screen(doc).includes('agent notes'), 'editor shows the agent document');

    // The row above Pi's input names both previews; /panels opens Pi's own selector, which keys answer.
    const besidePi = () => t('list-panes', '-t', pi, '-F', '#{pane_id}').split('\n');
    const panelsRow = () => t('show-options', '-pqv', '-t', pi, '@pi_panels');
    await until(() => / Diff: repo .*#\[reverse\] notes\.md /.test(panelsRow()), 'Pi writes its Panels row: both tabs, the editor highlighted');
    o('new-session', '-d', '-s', 'outer', '-x', '220', '-y', '50', `env -u TMUX tmux -L ${socket} attach -t pi`);
    await until(() => t('list-clients'), 'a client attached');
    t('send-keys', '-t', pi, '/reload', 'Enter');
    await until(() => screen(pi).includes('Reloaded keybindings'), 'reload completed');
    await until(() => panelsRow().includes(' Diff: repo '), 'the Panels row is redrawn after reload');
    t('send-keys', '-t', pi, '/panels', 'Enter');
    await until(() => screen(pi).includes('Show beside Pi') && screen(pi).includes('type to filter'), 'the selector is drawn in Pi');
    assert.match(screen(pi), /→ repo · \d+ changed, window/, 'the changed repository comes first, selected');
    assert.match(screen(pi), /notes\.md repo\/notes\.md · document, beside Pi/, 'the document is listed with where it is');
    const evidence = process.env.DIFF_PANE_EVIDENCE;
    if (evidence) writeFileSync(join(evidence, 'panels-menu.txt'), o('capture-pane', '-p', '-t', 'outer'));
    t('send-keys', '-t', pi, 'Enter');
    await until(() => besidePi().includes(diff), 'the chosen Hunk is beside Pi');
    await until(() => panelsRow().includes('#[reverse] Diff: repo '), 'the row follows');
    if (evidence) writeFileSync(join(evidence, 'after-choice.txt'), o('capture-pane', '-p', '-t', 'outer'));
    t('send-keys', '-t', pi, '/panel edit', 'Enter');
    await until(() => besidePi().includes(doc), '/panel still switches directly');
    t('send-keys', '-t', doc, 'G', 'o', 'unsaved-user-line', 'Escape');
    await until(() => screen(doc).includes('unsaved-user-line'), 'user typed in the editor');
    t('send-keys', '-t', pi, '/quit', 'Enter');
    await until(() => !t('list-panes', '-a', '-F', '#{pane_id}').split('\n').includes(diff), 'quit closes the diff pane');
    await until(() => screen(doc).includes('Pi exited; kept open'), 'quit keeps the editor with unsaved edits');
    t('send-keys', '-t', doc, ':wq', 'Enter');
    // Neovim may save by renaming the old file aside and writing a new one, so it can be briefly absent.
    await until(() => existsSync(join(work, 'notes.md')) && readFileSync(join(work, 'notes.md'), 'utf8').includes('unsaved-user-line'), 'the user saves after Pi exits');
  } finally {
    try { o('kill-server'); } catch {}
    try { t('kill-server'); } catch {}
    if (socketPath) rmSync(socketPath, { force: true });
    rmSync(e2e, { recursive: true, force: true });
  }
});

test('interactive Pi stopped by SIGTERM in a pane that survives leaves its saved editor and Hunk visible, with their document tabs', async () => {
  const e2e = realpathSync(mkdtempSync(join(tmpdir(), 'diff-pane-signal-')));
  const work = join(e2e, 'repo');
  const socket = `pi-diff-signal-${process.pid}`;
  const t = (...args) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8' }).trim();
  const until = async (check, message) => {
    for (let i = 0; i < 100; i++) { try { if (check()) return; } catch {} await sleep(100); }
    assert.fail(message);
  };
  let socketPath;
  try {
    execFileSync('git', ['init', '-q', work]);
    writeFileSync(join(work, 'tracked.txt'), 'one\n');
    execFileSync('git', ['add', '.'], { cwd: work });
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'base'], { cwd: work });
    // Scripted model: one turn changes code and writes two documents (the older one gets a tab, no buffer).
    writeFileSync(join(e2e, 'scripted.ts'), `import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
export default function (pi) {
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'scripted' }] });
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('bash', { command: 'echo agent-line >> tracked.txt; printf "# Older\\\\n" > older.md; touch -t 202001010000 older.md; printf "# Notes\\\\n\\\\nagent notes\\\\n" > notes.md' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('all done'),
  ]);
  pi.registerProvider(faux.provider);
}
`);
    t('new-session', '-d', '-s', 'pi', '-x', '220', '-y', '50', '-n', 'spare', 'sleep 120');
    socketPath = t('display-message', '-p', '#{socket_path}');
    t('source-file', join(root, 'tmux/pi-tabs.conf'));
    // Pi runs from a shell that stays after it exits, as when it is started from a terminal's shell.
    const command = ['env', `PI_CODING_AGENT_DIR=${join(e2e, 'agent')}`, 'pi', '--no-session', '--offline', '-ne',
      '-e', join(root, 'pi/extensions/diff-pane.ts'), '-e', join(e2e, 'scripted.ts'), '--provider', 'faux', '--model', 'scripted']
      .map(arg => `'${arg}'`).join(' ');
    const pi = t('new-window', '-P', '-F', '#{pane_id}', '-t', 'pi', '-c', work, `sh -c "${command}; exec sleep 120"`);
    const screen = pane => t('capture-pane', '-p', '-t', pane);
    const opt = (pane, name, scope = '-p') => t('show-options', scope + 'qv', '-t', pane, name);
    await until(() => screen(pi).includes('diff-pane.ts'), 'Pi started with the extension');
    t('send-keys', '-t', pi, 'go', 'Enter');
    await until(() => screen(pi).includes('all done'), 'the turn finished');
    const owned = tag => t('list-panes', '-a', '-F', `#{pane_id} #{${tag}}`).split('\n').filter(row => row.endsWith(` ${pi}`)).map(row => row.split(' ')[0]);
    await until(() => owned('@pi_doc_owner').length === 1 && owned('@pi_diff_owner').length === 1, 'an editor and a Hunk opened');
    const [doc] = owned('@pi_doc_owner'), [diff] = owned('@pi_diff_owner');
    await until(() => screen(doc).includes('agent notes'), 'the editor shows the newer document (saved)');
    assert.equal(opt(diff, '@pi_preview_window', '-w'), '1', 'the Hunk waits in a hidden window');
    const docs = [join(work, 'older.md'), join(work, 'notes.md')].map(file => realpathSync(file)).sort();
    assert.deepEqual(opt(pi, '@pi_docs').split('\n').sort(), docs, 'both documents are tabs');
    const pid = Number(opt(pi, '@pi_pid').split(' ')[0]);
    assert.ok(pid && pid !== process.pid, 'the disposable Pi recorded its own process');

    process.kill(pid, 'SIGTERM');
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'Pi exits on SIGTERM');
    const panes = () => t('list-panes', '-a', '-F', '#{pane_id}').split('\n');
    assert.ok(panes().includes(pi), 'its pane stays, running the shell\'s sleep');
    await until(() => opt(diff, '@pi_preview_window', '-w') === '', 'the Hunk window is shown again');
    assert.ok(panes().includes(doc) && panes().includes(diff), 'the saved editor and the Hunk keep running');
    assert.deepEqual([opt(doc, '@pi_panels'), opt(diff, '@pi_panels'), opt(pi, '@pi_panels'), opt(pi, '@pi_owner')], ['', '', '', ''],
      'no row or Pi mark of the stopped Pi remains');
    assert.deepEqual(opt(doc, '@pi_docs').split('\n').sort(), docs, 'the editor keeps every document tab for a resume');
    assert.equal(opt(doc, '@pi_doc_owner'), pi, 'still tagged for adoption');
    assert.ok(opt(doc, '@pi_session'), 'with its session');
    assert.match(opt(pi, '@pi_pid'), / left$/, 'the departure is marked');
  } finally {
    try { t('kill-server'); } catch {}
    if (socketPath) rmSync(socketPath, { force: true });
    rmSync(e2e, { recursive: true, force: true });
  }
});
