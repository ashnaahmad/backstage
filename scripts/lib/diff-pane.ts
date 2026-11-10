// Live preview beside the owning Pi pane: Hunk for changed code, an editable Neovim for changed Markdown.
// One preview is visible at a time; /panel switches between them.
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { lstat, open, readdir, readlink, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const DIFF_OWNER = '@pi_diff_owner';
const DIFF_ROOT = '@pi_diff_root';        // repository a Hunk pane shows
const DIFF_EMPTY = '@pi_diff_empty_';     // + Hunk pane number, set on the Pi pane when that Hunk exits with nothing to show
export const DOC_OWNER = '@pi_doc_owner';
const DOC_SERVER = '@pi_doc_server';
export const PANELS = '@pi_panels';               // window option: this Pi's Panels tab row (tmux/pi-tabs.conf)
export const PI_WINDOW = '@pi_window';            // window option: the Pi pane running here
export const DOCS = '@pi_docs';                    // pane option on Pi: its Markdown documents, one path per line;
                                                   // copied to its editor, which keeps them if Pi's pane goes
const PI_OWNER = '@pi_owner';                      // pane option: this pane runs a Pi with previews or documents
const SESSION = '@pi_session';                     // pane option on Pi and its previews: the Pi session they belong to
const PI_PID = '@pi_pid';                          // pane option on Pi: its process and the pane's, to tell a live Pi from a dead one;
const LEFT = 'left';                               // then this mark once that Pi has released its previews on leaving
export const PREVIEW_WINDOW = '@pi_preview_window'; // window option: a waiting preview, left out of the Windows row
const WRITING = '@pi_writing';                      // pane option on an editor in the writing view (setWriting)
export const TABS = fileURLToPath(new URL('../tmux-tabs.mjs', import.meta.url));
const READ_ONLY = new Set(['read', 'grep', 'find', 'ls']);
const MARKDOWN = /\.(md|markdown)$/i;
const WRITES = new Set(['edit', 'write']);
const EDITOR_CONFIG = fileURLToPath(new URL('../../nvim/pi-markdown/init.lua', import.meta.url));
const TASK = fileURLToPath(new URL('../tmux-task.sh', import.meta.url));

async function output(file, args, cwd) {
  return (await run(file, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })).stdout;
}
// Snapshots must not take index.lock while the agent's own git commands run.
const git = (root, ...args) => output('git', ['--no-optional-locks', ...args], root);
export const tmux = (...args) => output('tmux', args);

export function findExecutable(name, path = process.env.PATH ?? '') {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try { accessSync(join(dir, name), constants.X_OK); return join(dir, name); } catch {}
  }
}

export async function repoRoot(cwd) {
  try { return (await git(cwd, 'rev-parse', '--show-toplevel')).trim(); } catch {}
}

/**
 * The main checkout of a linked worktree (a sandbox or verification worktree made from it), or
 * undefined for a main checkout or a bare repository: the first entry `git worktree list` gives.
 */
export async function mainCheckout(root) {
  let listing;
  try { listing = await git(root, 'worktree', 'list', '--porcelain'); } catch { return; }
  const [first] = listing.split('\n\n');
  if (!first || first.split('\n').includes('bare')) return;
  const path = first.split('\n')[0].replace(/^worktree /, '');
  const checkout = await repoRoot(path);
  return checkout && checkout !== root ? checkout : undefined;
}

/**
 * The cwd's repository; for a linked worktree, the main checkout it was made from; then each
 * repository named by its `pi.previewRoot` Git config values (relative to its top level). Top
 * levels are canonical, so aliases of one repository count once.
 */
export async function previewRoots(cwd) {
  const main = await repoRoot(cwd);
  if (!main) return { roots: [], missing: [] };
  let values = [];
  try { values = (await git(main, 'config', '--get-all', 'pi.previewRoot')).split('\n').filter(Boolean); } catch {}  // unset
  const home = await mainCheckout(main);
  const roots = [main, ...(home ? [home] : [])], missing = [];
  for (const value of values) {
    const root = await repoRoot(resolve(main, value));
    if (!root) missing.push(value);
    else if (!roots.includes(root)) roots.push(root);
  }
  return { roots, missing };
}

// Every worktree path `git worktree list` gives for these repositories.
async function worktreeList(roots) {
  const paths = new Set();
  for (const root of roots) {
    const listing = await git(root, 'worktree', 'list', '--porcelain').catch(() => '');
    for (const block of listing.split('\n\n')) {
      const [line] = block.split('\n');
      if (line?.startsWith('worktree ')) paths.add(line.slice('worktree '.length));
    }
  }
  return paths;
}

async function headCommit(root) {
  try { return (await git(root, 'rev-parse', '--verify', '--quiet', 'HEAD')).trim(); } catch {}
}

// Effective worktree mode and content, the same whether or not the path is staged or tracked.
async function worktreeState(file) {
  const info = await lstat(file).catch(() => undefined);
  if (!info) return 'missing';
  if (info.isSymbolicLink()) return `120000 ${await readlink(file).catch(() => '')}`;
  if (!info.isFile()) return 'other';
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(file)) hash.update(chunk); } catch { return 'missing'; }
  return `${info.mode & 0o111 ? '100755' : '100644'} ${hash.digest('hex')}`;
}

/**
 * Worktree state of every path Hunk would show against HEAD (staged, unstaged, untracked):
 * path → mode and content. Staging and timestamps alone do not change it.
 */
export async function snapshot(root) {
  const head = await headCommit(root);
  const files = new Map();
  for (const path of await shownPaths(root, head)) files.set(path, await worktreeState(resolve(root, path)));
  return { head, files };
}

// What a diff covers: the whole repository except the page snapshots Playwright's CLI writes into the
// directory it runs in (pi-playwright), which are browser output rather than work to review. A
// pathspec, so git and Hunk leave out the same files.
const SHOWN = ['.', ':(exclude,glob)**/.playwright-cli/**'];

/** Paths Hunk would list against HEAD, without reading their content. */
export async function shownPaths(root, head) {
  const base = head ?? (await git(root, 'hash-object', '-t', 'tree', '/dev/null')).trim();
  const tracked = (await git(root, 'diff', '--no-ext-diff', '--no-renames', '--name-only', '-z', base, '--', ...SHOWN)).split('\0');
  const untracked = (await git(root, 'ls-files', '--others', '--exclude-standard', '-z', '--', ...SHOWN)).split('\0');
  return [...new Set([...tracked, ...untracked].filter(Boolean))];
}

/** Paths whose displayable state changed between snapshots; none when HEAD moved (checkout, pull, commit). */
export function changedPaths(before, after) {
  if (before.head !== after.head) return [];
  return [...after.files].filter(([path, state]) => before.files.get(path) !== state).map(([path]) => path);
}

/**
 * Every pane on the server as tab-separated `format` fields, the pane id first. Each pane once:
 * grouped sessions (a view per terminal, scripts/tmux-view.sh) list a shared window once per session.
 */
export async function allPanes(format) {
  const rows = (await tmux('list-panes', '-a', '-F', format)).split('\n').filter(Boolean).map(row => row.split('\t'));
  const seen = new Set();
  return rows.filter(([id]) => !seen.has(id) && seen.add(id));
}

// tmux 3.8 prints nothing, without failing, for a pane that does not exist.
export const paneExists = async pane => (await tmux('display-message', '-p', '-t', pane, '#{pane_id}').catch(() => '')).trim() === pane;

/**
 * Every preview this Pi owns, wherever it is: beside Pi or parked in its own window.
 * `name` is what /panel accepts; `label` names a parked window.
 */
async function ownedPreviews(owner) {
  const format = ['#{pane_id}', '#{window_id}', '#{window_index}', '#{pane_active}', `#{${DIFF_OWNER}}`, `#{${DOC_OWNER}}`, `#{${DIFF_ROOT}}`,
    '#{pane_current_path}', `#{${WRITING}}`].join('\t');
  const rows = await allPanes(format);
  const previews = [];
  for (const [id, window, index, active, diff, doc, tagged, cwd, writing] of rows) {
    if (doc === owner) previews.push({ id, window, index, active: active === '1', key: 'doc', name: 'edit', label: 'edit', writing: writing === '1' });
    if (diff !== owner) continue;
    // A Hunk pane from before root tags shows the repository it was started in.
    const root = tagged || await repoRoot(cwd) || cwd;
    if (!tagged) await tmux('set-option', '-p', '-t', id, DIFF_ROOT, root).catch(() => {});
    previews.push({ id, window, index, active: active === '1', key: `diff:${root}`, root, name: basename(root), label: `diff:${basename(root)}` });
  }
  return previews.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

// A window left with only ccmux sidebars once its preview has gone.
export async function dropSidebarOnly(window) {
  const commands = (await tmux('list-panes', '-t', window, '-F', '#{pane_current_command}').catch(() => '')).split('\n').filter(Boolean);
  if (commands.length && commands.every(command => command === 'ccmux')) await tmux('kill-window', '-t', window).catch(() => {});
}

export const docServer = async pane => (await tmux('show-options', '-pqv', '-t', pane, DOC_SERVER).catch(() => '')).trim();
export const remoteExpr = async (nvim, server, expr) =>
  (await run(nvim, ['--clean', '--server', server, '--remote-expr', expr], { encoding: 'utf8', timeout: 3000 })).stdout.trim();

/** Pi's window, its previews, and the one beside Pi. */
export async function layoutOf(owner) {
  const window = (await tmux('display-message', '-p', '-t', owner, '#{window_id}')).trim();
  const previews = await ownedPreviews(owner);
  return { window, previews, visible: previews.find(preview => preview.window === window) };
}

// Swapping keeps the slot's size and the parked window; the window is renamed after its new preview.
// An editor in the writing view stays in its own window until the view is turned off (setWriting).
export async function bringBeside(owner, preview, visible) {
  if (preview.id === visible?.id || preview.writing) return;
  if (visible) {
    await tmux('swap-pane', '-d', '-s', preview.id, '-t', visible.id);
    await tmux('rename-window', '-t', visible.id, visible.label);
  } else {
    await tmux('join-pane', '-d', '-h', '-s', preview.id, '-t', owner);
    await dropSidebarOnly(preview.window);
  }
}

/**
 * Starts a preview command for `owner`: beside Pi when nothing is shown there, otherwise in its own
 * waiting window after Pi's. It runs under the task wrapper, which closes a waiting window's leftover
 * ccmux sidebar on exit and redraws the Panels row of the Pi that owns its pane then. The preview
 * belongs to the owner's session (see `adoptPreviews`).
 */
export async function startPreview(owner, { window, visible }, label, root, vars, command) {
  const args = ['-d', '-P', '-F', '#{pane_id}', '-c', root,
    ...Object.entries({ ...vars, PI_PANELS_OWNER: owner, PI_TABS: TABS }).flatMap(([key, value]) => ['-e', `${key}=${value}`]), TASK, ...command];
  let pane;
  if (!visible) pane = (await tmux('split-window', '-h', '-t', owner, ...args)).trim();
  else {
    pane = (await tmux('new-window', '-a', '-t', window, '-n', label, ...args)).trim();
    await tmux('set-option', '-w', '-t', pane, PREVIEW_WINDOW, '1').catch(() => {});
  }
  const session = (await tmux('show-options', '-pqv', '-t', owner, SESSION).catch(() => '')).trim();
  if (session) await tmux('set-option', '-p', '-t', pane, SESSION, session).catch(() => {});
  return pane;
}

/** Starts this Pi's single Markdown editor on `file`. */
export async function startEditor(owner, place, file, nvim = findExecutable('nvim')) {
  const server = join(tmpdir(), `pi-markdown-${randomBytes(6).toString('hex')}.sock`);
  // Home, not the document's folder: a worktree removed later would leave Neovim without a working
  // directory, and the renderer fails on every redraw.
  const pane = await startPreview(owner, place, 'edit', homedir(), { NVIM_APPNAME: 'pi-markdown' },
    [nvim, '-u', EDITOR_CONFIG, '--listen', server, '--', file]);
  await tmux('set-option', '-p', '-t', pane, DOC_SERVER, server);
  await tmux('set-option', '-p', '-t', pane, DOC_OWNER, owner);
  await tmux('set-option', '-p', '-t', pane, DOCS, (await documents(owner)).join('\n'));
  return pane;
}

const canonical = file => { try { return realpathSync(file); } catch { return resolve(file); } };
const hex = file => Buffer.from(file).toString('hex');
/** A document's id in its tab's click range (tmux allows 15 bytes): stable while other tabs come and go. */
export const docId = file => createHash('sha256').update(file).digest('hex').slice(0, 8);

/**
 * Runs `task` holding this Pi's document lock, shared by Pi, the click helper and redraw processes, so
 * list updates, starting or closing the editor and redraws of the Panels row never interleave. Not
 * reentrant: a task must not call a function that takes the lock again. A small perl child holds an OS advisory
 * lock (flock) until its stdin closes; the kernel releases it if either process dies, so there is no
 * stale lock to recover. Menus waiting for the user are shown after `display-menu` returns, so no lock
 * is held while they wait.
 */
export function withDocuments(owner, task) {
  return withLock(`pi-docs-${serverKey()}-${owner.slice(1)}.lock`, task);
}
const serverKey = () => createHash('sha256').update((process.env.TMUX ?? '').split(',')[0]).digest('hex').slice(0, 8);

async function withLock(name, task) {
  const lock = join(tmpdir(), name);
  const holder = spawn('perl', ['-e', 'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or die "$!\\n"; flock($f, LOCK_EX) or die "$!\\n"; $| = 1; print "locked\\n"; <STDIN>;', lock],
    { stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    await new Promise((locked, failed) => {
      const timer = setTimeout(() => failed(new Error('documents are busy; try again')), 15000);
      holder.stdout.once('data', () => { clearTimeout(timer); locked(); });
      holder.once('error', error => { clearTimeout(timer); failed(error); });
      holder.once('exit', code => { clearTimeout(timer); failed(new Error(`document lock unavailable (perl exited ${code})`)); });
    });
  } catch (error) {
    holder.kill();
    throw error;
  }
  try { return await task(); } finally { holder.stdin.end(); }
}

/** This Pi's Markdown documents: every one agent changes, /edit or /panels brought in, until closed. */
export async function documents(owner) {
  return (await tmux('show-options', '-pqv', '-t', owner, DOCS).catch(() => '')).split('\n').filter(Boolean);
}
export async function addDocuments(owner, files) {
  const list = await documents(owner);
  for (const file of files.map(canonical)) if (!list.includes(file)) list.push(file);
  await setDocuments(owner, list);
}
export async function removeDocument(owner, file) {
  await setDocuments(owner, (await documents(owner)).filter(entry => entry !== file));
}
async function setDocuments(owner, list) {
  const editors = (await allPanes(`#{pane_id}\t#{${DOC_OWNER}}`)).filter(([, tag]) => tag === owner).map(([id]) => id);
  for (const pane of [owner, ...editors]) await tmux('set-option', '-p', '-t', pane, DOCS, list.join('\n'));
}

// What became of the Pi that owned a preview: 'live' while its recorded process runs (a reused process
// id reads as live); 'gone' once its pane has closed or died, or when the process that started it there
// (a shell) still runs the pane, alone and in the foreground. Anything else is 'unclear': something
// runs in that pane, perhaps a new Pi that has not recorded itself yet.
async function ownerState(pane, panes) {
  if (!panes.has(pane)) return 'gone';
  const [recorded, current, dead] = (await tmux('display-message', '-p', '-t', pane, `#{${PI_PID}}\t#{pane_pid}\t#{pane_dead}`)).trim().split('\t');
  const [pid, launcher, left] = recorded.split(' ');
  if (left === LEFT) return 'gone';   // released while leaving (releaseOrphans); a new Pi records itself afresh
  if (!Number(pid)) return 'live';
  try { process.kill(Number(pid), 0); return 'live'; } catch (error) { if (error.code === 'EPERM') return 'live'; }
  if (dead === '1') return 'gone';
  if (launcher !== current) return 'unclear';
  const foreground = await output('ps', ['-o', 'tpgid=', '-p', current]).then(text => text.trim(), () => '');
  const group = await output('ps', ['-A', '-o', 'pid=,pgid=']).then(text => text.split('\n').map(line => line.trim().split(/\s+/))
    .filter(([, pgid]) => pgid === current).map(([id]) => id), () => undefined);
  return foreground === current && group?.length === 1 && group[0] === current ? 'gone' : 'unclear';
}

const openFiles = (nvim, pane) => docServer(pane).then(server => remoteExpr(nvim, server,
  "json_encode(map(filter(getbufinfo({'buflisted': 1}), 'v:val.name != \"\"'), 'v:val.name'))")).then(JSON.parse, () => undefined);

// Holds `session`'s lock: what becomes of its previews when a Pi goes (releaseOrphans) or resumes it
// (claimSession) is decided by one process at a time.
function withSession(session, task) {
  return withLock(`pi-session-${serverKey()}-${createHash('sha256').update(session).digest('hex').slice(0, 12)}.lock`, task);
}

/**
 * At Pi's session start: records `session` and this process on Pi's pane, before waiting for any lock, so
 * no other Pi's claim mistakes this one for gone. Then its previews take the session, an editor this pane
 * kept (after Pi quit with unsaved text) gets its documents back, and previews of that session whose Pi
 * has gone (restarted or resumed elsewhere) are adopted, unless this Pi already has one of that kind. An
 * adopted editor brings its documents: the old Pi's list, from its pane if that survives and from the
 * editor's copy, and every file it has open. Previews of a live Pi, other sessions' and untagged ones are
 * left alone. A lock per session keeps two Pis resuming it from both adopting a preview.
 * Returns, of that session's other editors: `adopted` and its `unanswered` ones (kept with whatever they
 * hold rather than replaced); `unclear`, whose Pi may still run, so not taken ({ id, owner }); `kept`,
 * left because this Pi has an editor already.
 */
export async function claimSession(owner, session, { nvim = findExecutable('nvim'), pid = process.pid } = {}) {
  const launcher = (await tmux('display-message', '-p', '-t', owner, '#{pane_pid}')).trim();
  await tmux('set-option', '-p', '-t', owner, PI_PID, `${pid} ${launcher}`);
  await tmux('set-option', '-p', '-t', owner, SESSION, session);
  return withSession(session, () => withDocuments(owner, async () => {
    const mine = await ownedPreviews(owner);
    for (const preview of mine) await tmux('set-option', '-p', '-t', preview.id, SESSION, session).catch(() => {});
    const own = mine.find(preview => preview.key === 'doc');
    if (own) await addDocuments(owner, await documents(own.id));
    const kinds = new Set(mine.map(preview => preview.key));
    const rows = await allPanes(['#{pane_id}', `#{${SESSION}}`, `#{${DOC_OWNER}}`, `#{${DIFF_OWNER}}`, `#{${DIFF_ROOT}}`].join('\t'));
    const panes = new Set(rows.map(([id]) => id));
    const result = { adopted: [], unanswered: [], unclear: [], kept: [] };
    for (const [id, tagged, doc, diff, root] of rows) {
      const previous = doc || diff;
      const kind = doc ? 'doc' : root && `diff:${root}`;
      if (tagged !== session || !previous || previous === owner || !kind) continue;
      const state = await ownerState(previous, panes);
      if (state === 'live') continue;
      if (state === 'unclear' || kinds.has(kind)) {
        if (doc && state === 'unclear') result.unclear.push({ id, owner: previous });
        else if (doc) result.kept.push(id);
        continue;
      }
      await tmux('set-option', '-p', '-t', id, doc ? DOC_OWNER : DIFF_OWNER, owner);
      if (doc) {
        const open = await openFiles(nvim, id);
        if (!open) result.unanswered.push(id);
        await addDocuments(owner, [...(panes.has(previous) ? await documents(previous) : []), ...await documents(id), ...open ?? []]);
      }
      kinds.add(kind);
      result.adopted.push(id);
    }
    await drawPanels(owner, { nvim }).catch(() => {});
    return result;
  }));
}

/**
 * Previews whose Pi went without quitting (its pane was killed or closed with its window, Pi died, or a
 * signal stopped it): they keep running with whatever they hold, saved or not, still tagged with their
 * session, so resuming it takes them back (claimSession) with every document tab. Until then they are
 * ordinary windows: shown in the Windows row, with no Panels row of the gone Pi. A Pi's deliberate quit
 * closes its own previews instead (`close`). Panes and windows where no Pi runs any more lose their Pi
 * marks. Runs from tmux hooks whenever a pane closes (tmux/pi-tabs.conf), from a Pi stopped by a signal
 * or quitting after its pane has gone (`leaving`: its pane and process, marked as gone though the process
 * still runs, only while it is still the Pi recorded there, never a new Pi started in that pane), and
 * after a window is closed from its tab.
 * Each decision is made again under the session's lock (as adoption is) and the old Pi pane's documents
 * lock (as its redraws are), so neither an adoption nor a new Pi in that pane is undone by a stale view.
 */
export async function releaseOrphans({ leaving } = {}) {
  if (leaving && await paneExists(leaving.pane)) {
    // Marks the departure while that process is still the Pi recorded there, so every later judgement
    // (this one, redraws before the process has exited) sees it gone, and a new Pi there does not.
    const session = (await tmux('show-options', '-pqv', '-t', leaving.pane, SESSION).catch(() => '')).trim();
    const mark = () => withDocuments(leaving.pane, async () => {
      const recorded = (await tmux('show-options', '-pqv', '-t', leaving.pane, PI_PID).catch(() => '')).trim().split(' ');
      if (recorded[0] === String(leaving.pid)) await tmux('set-option', '-p', '-t', leaving.pane, PI_PID, `${recorded[0]} ${recorded[1]} ${LEFT}`);
    });
    await (session ? withSession(session, mark) : mark());
  }
  const gone = async pane => !await paneExists(pane) || await ownerState(pane, new Set([pane])).then(state => state === 'gone', () => false);
  const seen = new Map();   // for finding candidates; each change decides again under its locks
  const looksGone = pane => seen.get(pane) ?? seen.set(pane, gone(pane)).get(pane);
  const rows = await allPanes(['#{pane_id}', `#{${SESSION}}`, `#{${DOC_OWNER}}`, `#{${DIFF_OWNER}}`,
    `#{${PANELS}}`, `#{${PREVIEW_WINDOW}}`, `#{${PI_OWNER}}`].join('\t'));
  // A pane where Pi has gone (a shell it ran in, or the pane of a Pi leaving) is no longer a Pi's, nor shows its row.
  const unmark = async pane => {
    await tmux('set-option', '-pu', '-t', pane, PI_OWNER).catch(() => {});
    await tmux('set-option', '-pu', '-t', pane, PANELS).catch(() => {});
  };
  for (const [id, session, , , , , flag] of rows) {
    if (!flag || !await looksGone(id)) continue;
    await (session ? withSession(session, () => withDocuments(id, async () => {
      if (await gone(id)) await unmark(id);
    })) : unmark(id));
  }
  const groups = new Map();   // session and gone owner → its previews still marked as that Pi's
  for (const [id, session, doc, diff, row, waiting] of rows) {
    const previous = doc || diff;
    if (!previous || (!row && !waiting) || !await looksGone(previous)) continue;
    const key = `${session}\n${previous}`;
    if (!groups.has(key)) groups.set(key, { session, previous, previews: [] });
    groups.get(key).previews.push({ id, tag: doc ? DOC_OWNER : DIFF_OWNER });
  }
  for (const { session, previous, previews } of groups.values()) {
    const release = () => withDocuments(previous, async () => {
      if (!await gone(previous)) return;   // a new Pi in that pane
      for (const { id, tag } of previews) {
        // A resuming Pi may have taken it over meanwhile.
        if ((await tmux('show-options', '-pqv', '-t', id, tag).catch(() => '')).trim() !== previous) continue;
        await tmux('set-option', '-pu', '-t', id, PANELS).catch(() => {});
        const window = (await tmux('display-message', '-p', '-t', id, '#{window_id}').catch(() => '')).trim();
        if (!window || await piRuns(window)) continue;
        await tmux('set-option', '-wu', '-t', window, PREVIEW_WINDOW).catch(() => {});
        await tmux('set-option', '-wu', '-t', window, PANELS).catch(() => {});
      }
    });
    await (session ? withSession(session, release) : release());
  }
  // Window marks follow the panes' (drawPanels sets them again when a Pi there redraws).
  const marked = (await tmux('list-windows', '-a', '-F', `#{window_id}\t#{${PI_WINDOW}}`)).split('\n').map(line => line.split('\t'))
    .filter(([, flag]) => flag).map(([id]) => id);
  for (const window of new Set(marked)) {
    if (await piRuns(window)) continue;
    await tmux('set-option', '-wu', '-t', window, PI_WINDOW).catch(() => {});
    await tmux('set-option', '-wu', '-t', window, PANELS).catch(() => {});
  }
}
// Whether a pane of `window` is marked as running a Pi.
const piRuns = async window => (await tmux('list-panes', '-t', window, '-F', `#{${PI_OWNER}}`).catch(() => '')).split('\n').some(Boolean);

/**
 * The editor's own account of itself (PiMarkdownState in nvim/pi-markdown/init.lua), the one source for
 * whether it holds unsaved text: its current file (the side with the cursor), the files on screen, its
 * unsaved files, and `modified`, how many buffers hold unsaved text, typed text in an unnamed buffer
 * included. Undefined when the editor does not answer.
 */
export async function editorState(nvim, pane) {
  const reply = await remoteExpr(nvim, await docServer(pane), 'v:lua.PiMarkdownState()').catch(() => undefined);
  if (!reply) return undefined;
  const { current, shown, unsaved, modified } = JSON.parse(reply);
  return { current: current && canonical(current), shown: new Set((shown ?? [current]).filter(Boolean).map(canonical)),
    unsaved: new Set(unsaved.map(canonical)), modified };
}

// Document operations: each holds the lock for its whole change and redraws the Panels row before
// releasing it, so callers neither take the lock nor redraw. Since every redraw holds the same lock,
// one written from older state cannot land after these operations' changes. Changes made outside the
// lock (typing in Neovim, moving Hunk) rely on the redraw that follows them. Nothing is rolled back: a
// step that fails leaves the earlier ones in place, and the redraw is still attempted, to show what
// took effect. A failing step's own error is what the operation throws; when the change succeeds but
// the redraw fails, it returns `warning` for the caller to show.
async function changing(owner, nvim, task) {
  return withDocuments(owner, async () => {
    let result;
    try { result = await task(); } catch (error) {
      await drawPanels(owner, { nvim }).catch(() => {});
      throw error;
    }
    const warning = await drawPanels(owner, { nvim }).then(() => undefined, () => NOT_REDRAWN);
    return { ...result, warning };
  });
}
/** The warning for a change that took effect while the Panels row could not be redrawn. */
export const NOT_REDRAWN = 'Document updated, but the Panels bar could not refresh.';

/**
 * An explicit choice (a Panels tab, /edit, /panels): shows `file` in this Pi's editor beside Pi, adding it
 * to the documents. Switches buffers in the open editor (Neovim keeps unsaved text in the buffer left
 * behind), or starts the editor when none is open. In the writing view the document replaces the one in
 * the side with the cursor, or gets the cursor if either side shows it already, and the view stays.
 * Returns `{ window, warning }`: the window showing it, and see `changing`.
 */
export function selectDocument(owner, file, { nvim = findExecutable('nvim') } = {}) {
  return changing(owner, nvim, async () => {
    await addDocuments(owner, [file]);
    let place = await layoutOf(owner);
    let editor = place.previews.find(preview => preview.key === 'doc');
    if (editor) await remoteExpr(nvim, await docServer(editor.id), `v:lua.PiMarkdownOpen('${hex(file)}', ${editor.writing ? 2 : 1})`);
    else {
      const id = await startEditor(owner, place, file, nvim);
      place = await layoutOf(owner);
      editor = place.previews.find(preview => preview.id === id);
    }
    if (editor) await bringBeside(owner, editor, place.visible);
    return { window: editor?.writing ? editor.window : place.window };
  });
}

// A newly started editor answers once Neovim is listening.
async function answering(nvim, pane) {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise(done => setTimeout(done, 100))) {
    if (await remoteExpr(nvim, await docServer(pane), '1').then(() => true, () => false)) return true;
  }
  return false;
}

/**
 * The writing view: Pi's editor in its own window, two documents side by side (PiMarkdownWrite), while Pi
 * keeps running, unseen, in its window. The right side is the document that was beside Pi and stays when
 * Pi returns; the left takes Pi's place. `on` true turns it on, false off, undefined toggles, decided under
 * the lock. On: starts the editor on Pi's first document if none is open; Pi with no documents has
 * nothing to write in. Off: Pi back on the left, with the right side's document beside it; the left one
 * keeps its text behind it. Only this and Pi quitting end it: nothing else moves the editor (bringBeside), so
 * document choices meanwhile open in the writing view. Returns `{ window, message, warning }`: the
 * window to show, and why nothing changed.
 */
export function setWriting(owner, on, { nvim = findExecutable('nvim') } = {}) {
  return changing(owner, nvim, async () => {
    const place = await layoutOf(owner);
    const editor = place.previews.find(preview => preview.key === 'doc');
    if (!(on ?? !editor?.writing)) {
      if (!editor) return { window: place.window };
      // The view ends once the editor is beside Pi: a failed move leaves it whole, to try again. An editor
      // that does not answer keeps its sides.
      await bringBeside(owner, { ...editor, writing: false }, place.visible);
      await remoteExpr(nvim, await docServer(editor.id), 'v:lua.PiMarkdownSingle()').catch(() => {});
      await tmux('set-option', '-pu', '-t', editor.id, WRITING);
      return { window: place.window };
    }
    if (editor?.writing) return { window: editor.window };
    return enterWriting(owner, place, editor, undefined, nvim, other => `v:lua.PiMarkdownWrite('${hex(other)}')`);
  });
}

/**
 * Open on left, from a document tab's menu: `file` takes the left side of the writing view, which turns on
 * if it is off, and the right keeps the document shown there or beside Pi (PiMarkdownOpenLeft). Pi keeps
 * running, unseen. Returns as setWriting does.
 */
export function openOnLeft(owner, file, { nvim = findExecutable('nvim') } = {}) {
  return changing(owner, nvim, async () => {
    await addDocuments(owner, [file]);
    const place = await layoutOf(owner);
    return enterWriting(owner, place, place.previews.find(preview => preview.key === 'doc'), file, nvim,
      other => `v:lua.PiMarkdownOpenLeft('${hex(file)}', '${hex(other)}')`);
  });
}

// Under the lock: lays out the editor's two sides with `expr(other)`, `other` being another of Pi's documents
// for a side that needs one, then moves the editor to its own window, unless it is there already. Starts the
// editor (on `file`, else Pi's first document) when none is open.
async function enterWriting(owner, place, editor, file, nvim, expr) {
  const files = (await documents(owner)).filter(entry => existsSync(entry));
  if (!editor) {
    const first = file ?? files[0];
    if (!first) return { message: 'No document to write in: open one with /edit or /panels.' };
    const id = await startEditor(owner, place, first, nvim);
    editor = (await layoutOf(owner)).previews.find(preview => preview.id === id);
    if (!editor || !await answering(nvim, id)) return { message: 'The editor did not start; try again.' };
  }
  const current = (await editorState(nvim, editor.id))?.current;
  const other = files.find(entry => entry !== current && entry !== file) ?? '';
  const reply = await remoteExpr(nvim, await docServer(editor.id), expr(other));
  if (reply === 'alone') return { message: `${basename(file)} is the only document: open another to write beside it.` };
  if (reply !== 'writing' && reply !== 'already') return { message: 'The editor has no document to write in.' };
  if (editor.writing) return { window: editor.window };
  if (editor.window === place.window) await tmux('break-pane', '-d', '-a', '-s', editor.id, '-t', place.window, '-n', 'write');
  else await tmux('rename-window', '-t', editor.id, 'write');
  await tmux('set-option', '-p', '-t', editor.id, WRITING, '1');
  return { window: (await tmux('display-message', '-p', '-t', editor.id, '#{window_id}')).trim() };
}

/**
 * Agent changes: adds `files` as documents and loads `file` in the open editor, which keeps showing a
 * buffer with unsaved text. With no editor open, starts one only if `mayStart()` allows it; that runs
 * under the lock, so it must not take it. Does not move the editor beside Pi. Returns `{ pane, warning }`:
 * the editor pane, if any.
 */
export function loadDocuments(owner, files, file, { nvim = findExecutable('nvim'), mayStart = () => true } = {}) {
  return changing(owner, nvim, async () => {
    await addDocuments(owner, files);
    const place = await layoutOf(owner);
    let pane = place.previews.find(preview => preview.key === 'doc')?.id;
    if (pane) await remoteExpr(nvim, await docServer(pane), `v:lua.PiMarkdownOpen('${hex(file)}')`).catch(() => {});
    else if (await mayStart()) pane = await startEditor(owner, place, file, nvim);
    return { pane };
  });
}

/**
 * Closes one document: its buffer in the editor (the editor quits when it was the last) and its tab.
 * `how` is 'close', which never drops unsaved text, or the user's 'save' or 'discard'. Returns whether it
 * closed, the editor's message and any `warning`. With 'close', `closed: false` means unsaved text (or
 * an editor that does not answer) needs the user's choice.
 */
export function closeDocument(owner, file, how = 'close', { nvim = findExecutable('nvim') } = {}) {
  const mode = how === 'save' || how === 'discard' ? how : 'close';
  return changing(owner, nvim, async () => {
    const editor = (await layoutOf(owner)).previews.find(preview => preview.key === 'doc');
    let message = `Closed ${basename(file)}`;
    if (editor) {
      const reply = remoteExpr(nvim, await docServer(editor.id), `v:lua.PiMarkdownCloseDoc('${hex(file)}', '${mode}')`);
      message = mode === 'close' ? await reply.catch(() => 'Unsaved') : await reply;
    }
    // PiMarkdownCloseDoc's replies: 'Closed', 'Saved and closed' or 'Discarded' when the buffer has gone;
    // otherwise 'Unsaved' or 'Not saved', and the buffer stays open.
    const closed = /^(Closed|Saved and closed|Discarded)/.test(message);
    if (closed) await removeDocument(owner, file);
    return { closed, message };
  });
}

/**
 * The Panels tab row of tmux/pi-tabs.conf: a `Diff:` tab per open Hunk and a tab per document of
 * this Pi (`●` when unsaved in the editor), what is beside Pi highlighted, each with a close target.
 * Written as a pane option on Pi and each of its previews, so the row follows whichever Pi (or its
 * preview) is active even with two Pis in one window. Pi's window also gets it as a window option,
 * shown when another pane there (the ccmux sidebar) is active, unless a second Pi runs in that
 * window. A waiting window gets it too and is marked so the Windows row leaves it out. `gone` is an
 * exiting pane. Holds the document lock, so it does not overwrite a newer row from another redraw or
 * document operation.
 */
export function renderPanels(owner, { nvim = findExecutable('nvim'), gone } = {}) {
  return withDocuments(owner, () => drawPanels(owner, { nvim, gone }));
}

async function drawPanels(owner, { nvim, gone }) {
  const { window, previews, visible } = await layoutOf(owner);
  // A Pi that has gone has no row: its previews' refreshes must not bring one back (releaseOrphans).
  if (!window || await ownerState(owner, new Set([owner])) === 'gone') throw new Error(`the Pi of ${owner} has gone`);
  const shown = previews.filter(preview => preview.id !== gone);
  // Tabs stay short; the editor and /panels show full names.
  const tab = (select, close, name, highlighted) => {
    const short = name.length > 24 ? `${name.slice(0, 23)}…` : name;
    return `#[range=user|${select}]${highlighted ? '#[reverse]' : ''} ${short.replaceAll('#', '##')} #[noreverse]#[norange]#[range=user|${close}]×#[norange]`;
  };
  const tabs = shown.filter(preview => preview.key !== 'doc')
    .map(preview => tab(`ps${preview.id}`, `px${preview.id}`, `Diff: ${preview.name}`, preview === visible));
  const editor = shown.find(preview => preview.key === 'doc');
  const state = editor && nvim ? await editorState(nvim, editor.id) : undefined;
  const docs = await documents(owner);
  for (const file of docs) {
    // A removed file has no tab, unless the editor still holds its unsaved text; it returns if recreated.
    if (!state?.unsaved.has(file) && !existsSync(file)) continue;
    const name = `${basename(file)}${state?.unsaved.has(file) ? ' ●' : ''}`;
    tabs.push(tab(`ds${owner}:${docId(file)}`, `dx${owner}:${docId(file)}`, name, (editor === visible || editor?.writing) && state?.shown.has(file)));
  }
  // The writing view's switch (setWriting), first, once there is a document to write in.
  if (editor || docs.length) {
    tabs.unshift(`#[range=user|wv${owner}]${editor?.writing ? '#[reverse] π Show agent #[noreverse]' : ' ✎ Write '}#[norange]`);
  }
  const row = tabs.join('  ');
  for (const pane of [owner, ...shown.map(preview => preview.id)]) await tmux('set-option', '-p', '-t', pane, PANELS, row).catch(() => {});
  // The window's fallback row only when this is the only Pi in it, judged from the panes there now;
  // a fallback this Pi left in another window (Pi moved) is removed.
  await tmux('set-option', '-p', '-t', owner, PI_OWNER, '1');
  const residents = (await tmux('list-panes', '-t', window, '-F', `#{pane_id}\t#{${PI_OWNER}}`)).split('\n')
    .map(line => line.split('\t')).filter(([, flag]) => flag).map(([id]) => id);
  await tmux('set-option', '-w', '-t', window, PI_WINDOW, '1');
  if (residents.length === 1) await tmux('set-option', '-w', '-t', window, PANELS, row);
  else await tmux('set-option', '-wu', '-t', window, PANELS).catch(() => {});
  const elsewhere = (await tmux('list-windows', '-a', '-F', `#{window_id}\t#{${PANELS}}`)).split('\n').map(line => line.split('\t'))
    .filter(([id, value]) => id !== window && value?.includes(`ds${owner}:`)).map(([id]) => id);
  for (const id of elsewhere) {
    if (shown.some(preview => preview.window === id)) continue;
    await tmux('set-option', '-wu', '-t', id, PANELS).catch(() => {});
  }
  for (const parked of new Set(shown.filter(preview => preview.window !== window).map(preview => preview.window))) {
    // A window where another Pi runs is never hidden or given this Pi's row.
    if ((await tmux('show-options', '-wqv', '-t', parked, PI_WINDOW).catch(() => '')).trim()) continue;
    await tmux('set-option', '-w', '-t', parked, PANELS, row).catch(() => {});
    await tmux('set-option', '-w', '-t', parked, PREVIEW_WINDOW, '1').catch(() => {});
  }
}

/** A Markdown file of a skill: SKILL.md, or any Markdown under a folder holding one. */
export async function isSkillDocument(file) {
  if (!MARKDOWN.test(file)) return false;
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (await stat(join(dir, 'SKILL.md')).then(info => info.isFile(), () => false)) return true;
    if (dirname(dir) === dir) return false;
  }
}

// The file an edit or write tool call names, resolved as Pi's tools do (`@` prefix, `~`, relative to cwd).
function toolPath(event, cwd) {
  const path = event.input?.path;
  if (!WRITES.has(event.toolName) || typeof path !== 'string' || !path) return;
  const bare = path.replace(/^@/, '');
  return resolve(cwd, bare === '~' || bare.startsWith('~/') ? homedir() + bare.slice(1) : bare);
}

async function newest(docs) {
  const dated = await Promise.all(docs.map(async doc => [doc, (await stat(doc.file).catch(() => undefined))?.mtimeMs ?? 0]));
  return dated.sort((a, b) => b[1] - a[1])[0][0];
}

/**
 * Per-runtime controller. Every tmux operation is limited to panes tagged with this owner.
 * One preview is visible beside Pi; the others wait in their own windows of Pi's session.
 */
export function createDiffPane({ env = process.env, hunk = findExecutable('hunk', env.PATH), nvim = findExecutable('nvim', env.PATH) } = {}) {
  const owner = env.TMUX_PANE;
  // Keyed by preview: 'doc', or 'diff:' + repository root.
  const seen = new Map();          // pane seen during the current prompt
  const dismissed = new Set();
  const warned = new Set();
  let baseline;    // repositories' state before the current turn's first mutating tool call
  // Markdown edited or written this turn, wherever it lives: file → state before the first call. Whether
  // it belongs to a skill is decided after the turn, so a new skill's own SKILL.md counts too.
  let skillFiles = new Map();
  // Worktrees that are this session's, watched like its own repository: one it edited or wrote a file
  // in (another worktree of the watched repositories), or one chosen by its exact root with /panel or
  // show_panel (a worktree a script or command made, or one handed to an agent). Nothing is inferred
  // from commands or from a worktree appearing in `git worktree list`: either could be another agent's.
  // Restored from the session at start; `associated` are the new ones, for the caller to record.
  let worktrees = [], associated = [];
  const associate = root => { if (!worktrees.includes(root)) { worktrees.push(root); associated.push(root); } };
  let queue = Promise.resolve();
  const serial = task => (queue = queue.then(task, task));
  const available = mode => Boolean(mode === 'tui' && env.TMUX && owner && hunk);
  const remote = (server, expr) => remoteExpr(nvim, server, expr);
  const layout = () => layoutOf(owner);
  const bring = (preview, visible) => bringBeside(owner, preview, visible);

  // Hunk closing itself because it had nothing to show is not a dismissal.
  async function closedEmpty(pane) {
    const option = DIFF_EMPTY + pane.slice(1);
    const mark = (await tmux('show-options', '-pqv', '-t', owner, option)).trim();
    if (mark) await tmux('set-option', '-pu', '-t', owner, option);
    return Boolean(mark);
  }

  // Returns the existing pane, or undefined when this preview may open; false after the user closed it.
  async function existing(key, previews) {
    const pane = previews.find(preview => preview.key === key)?.id;
    if (pane) { seen.set(key, pane); return pane; }
    const last = seen.get(key);
    if (last && !await closedEmpty(last)) dismissed.add(key);
    seen.delete(key);
    return dismissed.has(key) ? false : undefined;
  }

  const start = (place, label, root, vars, command) => startPreview(owner, place, label, root, vars, command);

  // Automatic changes never move a preview the user is in, or an editor with unsaved text, out of view.
  async function busy(visible) {
    if (!visible) return false;
    if (visible.active) return true;
    if (visible.key !== 'doc') return false;
    const state = await editorState(nvim, visible.id);
    return !state || state.modified > 0;   // an editor that does not answer counts as holding unsaved text
  }

  // One Hunk per changed repository, each comparing against its own HEAD and dismissed on its own.
  async function showDiff(root) {
    const key = `diff:${root}`;
    const place = await layout();
    const pane = await existing(key, place.previews);
    if (pane !== undefined) return pane || undefined;
    const extension = name => ['--extension', fileURLToPath(new URL(`../../extensions/hunk/${name}`, import.meta.url))];
    const args = ['diff', ...(await headCommit(root) ? ['HEAD'] : []), '--watch',
      ...extension('recent-files.mjs'), ...extension('close-when-empty.mjs'), '--', ...SHOWN];
    const id = await start(place, `diff:${basename(root)}`, root, { HUNK_MCP_DISABLE: '1', PI_DIFF_OWNER: owner }, [hunk, ...args]);
    seen.set(key, id);
    // Hunk may already have exited with nothing to show. The root comes first: an owned pane always has one.
    await tmux('set-option', '-p', '-t', id, DIFF_ROOT, root).catch(() => {});
    await tmux('set-option', '-p', '-t', id, DIFF_OWNER, owner).catch(() => {});
    return id;
  }

  // The single editor takes the newest changed document across all repositories and is preferred
  // for display; otherwise the first changed repository. Returns a notice when it stays parked, and
  // whether documents were loaded.
  async function show(changes, skillDocs = []) {
    const panes = [], docs = [...skillDocs];
    for (const { root, paths, files } of changes) {
      const changed = nvim ? paths.filter(path => MARKDOWN.test(path) && files.get(path) !== 'missing') : [];
      if (paths.length > changed.length) panes.push(await showDiff(root));
      docs.push(...changed.map(path => ({ root, file: resolve(root, path) })));
    }
    if (docs.length) {
      // Every changed document gets a tab; the editor opens the newest. It is not restarted once the user
      // closed it this prompt.
      const { file } = await newest(docs);
      // Its redraw is superseded by the one after this display change (settle), which reports failure.
      const { pane } = await loadDocuments(owner, docs.map(doc => doc.file), file,
        { nvim, mayStart: async () => await existing('doc', []) !== false && !await heldElsewhere() });
      if (pane) seen.set('doc', pane);
      panes.unshift(pane);
    }
    const { previews, visible } = await layout();
    const target = previews.find(preview => preview.id === panes.find(Boolean));
    const loaded = docs.length > 0;
    if (!target || target.id === visible?.id || target.writing) return { loaded };
    if (await busy(visible)) return { notice: `${target.label} changed; /panel ${target.name} shows it`, loaded };
    await bring(target, visible);
    return { loaded };
  }
  const render = () => renderPanels(owner, { nvim }).catch(() => {});

  // This session's editors whose Pi may still run (claimSession's `unclear`): while one survives with that
  // owner, agent changes do not start an editor beside it; /edit still does. Once another Pi takes it
  // over, it is that Pi's own editor and no longer holds this one back.
  let held = [];
  const heldElsewhere = async () => held.length > 0 &&
    (await allPanes(`#{pane_id}\t#{${DOC_OWNER}}`)).some(([id, tag]) => held.some(editor => editor.id === id && editor.owner === tag));

  // What /panels lists: each configured repository with its current change count (one without changes
  // or a pane cannot be chosen), this Pi's documents, then Markdown to open: changed or new by Git's
  // view first, then every other Markdown file in those repositories (tracked or untracked, not
  // ignored), the top level of a working directory outside Git, and the top level of its parent.
  // `location` says where a file is, for display and search.
  // This session's worktrees of these repositories, still present and not among them.
  async function launched(roots) {
    const made = [];
    for (const path of worktrees) if (!roots.includes(path) && await repoRoot(path) === path) made.push(path);
    return made;
  }

  // What this Pi watches, the same for automatic previews and /panels: the repositories (previewRoots) and
  // the worktrees this session launched from them, each compared before and after a turn.
  async function watched(cwd) {
    const { roots, missing } = await previewRoots(cwd);
    return { roots, missing, made: roots.length ? await launched(roots) : [] };
  }

  // The repository diffs /panels lists first: the watched repositories, the worktrees this session
  // launched, then any other diff this Pi has open.
  async function diffEntries(cwd) {
    const { roots, made } = await watched(cwd);
    const { previews, visible } = await layout();
    const place = pane => pane && (pane === visible ? 'beside Pi' : `window ${pane.index}`);
    const list = [];
    const others = previews.filter(preview => preview.root && !roots.includes(preview.root) && !made.includes(preview.root))
      .map(preview => preview.root);
    for (const root of [...roots, ...made, ...others]) {
      const key = `diff:${root}`;
      const pane = previews.find(preview => preview.key === key);
      // Unknown is not the same as clean: a failed listing says so and only an open pane stays selectable.
      const count = await shownPaths(root, await headCommit(root)).then(paths => paths.length, () => undefined);
      const state = count === undefined ? 'status unavailable' : count ? `${count} changed` : 'no changes';
      list.push({ key, root, name: basename(root), pane, place: place(pane), state, enabled: Boolean(pane || count) });
    }
    return { roots, made, previews, place, list };
  }

  async function entries(cwd) {
    const { roots, made, previews, place, list } = await diffEntries(cwd);
    // Every document of this Pi, open in the editor or not, then Markdown already changed or new in
    // the watched repositories and launched worktrees (Git's view, as for the diffs); choosing one shows
    // it and makes it a tab. A launched worktree's unchanged Markdown is its repository's, listed below.
    const doc = previews.find(preview => preview.key === 'doc');
    const state = doc ? await editorState(nvim, doc.id) : undefined;
    const files = await documents(owner);
    for (const root of [...roots, ...made]) {
      const paths = await shownPaths(root, await headCommit(root)).catch(() => []);
      for (const path of paths.filter(path => MARKDOWN.test(path))) {
        const file = canonical(resolve(root, path));
        if (!files.includes(file) && await stat(file).then(info => info.isFile(), () => false)) files.push(file);
      }
    }
    const listed = new Set(await documents(owner));
    const changed = new Set(files.filter(file => !listed.has(file)));
    const isMarkdownFile = file => stat(file).then(info => info.isFile(), () => false);
    for (const root of roots) {
      const paths = await git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z').then(out => out.split('\0'), () => []);
      for (const path of paths.filter(path => MARKDOWN.test(path))) {
        const file = canonical(resolve(root, path));
        if (!files.includes(file)) files.push(file);
      }
    }
    const topLevel = async dir => (await readdir(dir).catch(() => [])).filter(name => MARKDOWN.test(name)).map(name => canonical(join(dir, name)));
    const loose = [...(roots.length ? [] : await topLevel(cwd)), ...await topLevel(dirname(cwd))];
    for (const file of loose) if (!files.includes(file) && await isMarkdownFile(file)) files.push(file);
    const home = homedir();
    const location = file => {
      const root = [...roots, ...made].find(root => file.startsWith(root + '/'));
      const where = root ? join(basename(root), file.slice(root.length + 1)) : file;
      return root ? where : where.startsWith(home + '/') ? `~${where.slice(home.length)}` : where;
    };
    for (const file of files) {
      if (!state?.unsaved.has(file) && !existsSync(file)) continue;
      const current = state?.current === file;
      list.push({ key: `doc:${file}`, file, name: basename(file), location: location(file), pane: current ? doc : undefined, place: current ? place(doc) : undefined,
        state: state?.unsaved.has(file) ? 'unsaved' : listed.has(file) ? 'document' : changed.has(file) ? 'changed' : '', enabled: true });
    }
    return list;
  }

  // An explicit choice reopens a closed repository preview, as /edit does for the editor.
  async function pick(entry) {
    let { previews, visible } = await layout();
    let pane = previews.find(preview => preview.key === entry.key);
    if (!pane && entry.root) {
      seen.delete(entry.key);
      dismissed.delete(entry.key);
      const id = await showDiff(entry.root);
      ({ previews, visible } = await layout());
      pane = previews.find(preview => preview.id === id);
    }
    if (pane) await bring(pane, visible);
  }

  // /edit, and /panel given a document: shows `path` (relative to Pi's directory) in the editor.
  // Returns a warning when the document is shown but its tab could not be drawn.
  async function edit(path, ctx) {
    if (ctx.mode !== 'tui' || !env.TMUX || !owner) throw new Error('/edit needs Pi running inside tmux.');
    if (!nvim) throw new Error('Install Neovim to use /edit (see SETUP.md).');
    const file = resolve(ctx.cwd, path);
    const info = await stat(file).catch(error => {
      if (error.code === 'ENOENT') throw new Error(`File not found: ${file}`);
      throw error;
    });
    if (!info.isFile()) throw new Error(`Not a file: ${file}`);
    // An explicit request reopens a dismissed editor, without changing automatic dismissal rules.
    return serial(async () => {
      seen.delete('doc');
      dismissed.delete('doc');
      const { warning } = await selectDocument(owner, file, { nvim });
      seen.set('doc', (await layout()).previews.find(preview => preview.key === 'doc')?.id);
      return warning;
    });
  }

  // /create: a new empty file at `path` (relative to Pi's directory), opened in the editor. Never
  // overwrites; the folder must exist; nothing is created when the editor cannot open it. Returns
  // edit's warning.
  async function create(path, ctx) {
    if (ctx.mode !== 'tui' || !env.TMUX || !owner) throw new Error('/create needs Pi running inside tmux.');
    if (!nvim) throw new Error('Install Neovim to use /create (see SETUP.md).');
    const file = resolve(ctx.cwd, path);
    const folder = await stat(dirname(file)).catch(() => undefined);
    if (!folder?.isDirectory()) throw new Error(`No such folder: ${dirname(file)}`);
    try {
      await (await open(file, 'wx')).close();
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`Already exists: ${file}. Open it with /edit or /panel.`);
      throw error;
    }
    try { return await edit(file, ctx); } catch (error) {
      throw new Error(`Created ${file}, but could not open it: ${error.message ?? error}`);
    }
  }


  return {
    hunk,
    nvim,
    available,
    entries,
    // At session start: the worktrees the session recorded as its own (see `worktrees`).
    setWorktrees(roots) { worktrees = [...new Set(roots)]; associated = []; },
    // Worktrees that became the session's since last asked, for the caller to record in the session.
    takeAssociated() { const fresh = associated; associated = []; return fresh; },
    // /panels: what can be shown beside Pi (see entries), for Pi's own selector.
    async choices(ctx) {
      if (ctx.mode !== 'tui' || !env.TMUX || !owner) throw new Error('/panels needs Pi running inside tmux.');
      return entries(ctx.cwd);
    },
    // Shows a chosen entry: a document in the editor as /edit does, a repository's diff (reopening one
    // that was closed). Returns a warning when the document is shown but its tab could not be drawn.
    async showChoice(entry, ctx) {
      if (!entry?.enabled) return;
      if (entry.file) return edit(entry.file, ctx);
      await serial(async () => { await pick(entry); await render(); });
    },
    edit,
    create,
    // Shows the named preview, or the next one, beside Pi. A name that is no open preview's may be a
    // repository /panels lists (its diff), else a document: a file path (as /edit takes it) or the name
    // of one existing document tab. Returns what happened.
    async panel(name, ctx) {
      if (ctx.mode !== 'tui' || !env.TMUX || !owner) throw new Error('/panel needs Pi running inside tmux.');
      const named = name && (await layout()).previews.some(preview => preview.name === name || preview.label === name);
      let looked;
      // A repository /panels lists (a launched worktree, or one whose diff was closed), by folder name.
      const diff = name && !named && (await diffEntries(ctx.cwd)).list.find(entry => entry.name === name);
      if (diff) {
        if (!diff.enabled) return `${name} has no changes to show.`;
        await serial(async () => { await pick(diff); await render(); });
        return `Showing the ${name} diff.`;
      }
      if (name && !named) {
        const file = resolve(ctx.cwd, name);
        // A folder: a Git worktree given by its exact top level becomes the session's (watched like its
        // own repository, recorded in the session) and its diff is shown.
        if (await stat(file).then(info => info.isDirectory(), () => false)) {
          const root = canonical(file);
          if (await repoRoot(root) !== root) return `${file} is not the top-level folder of a Git worktree; give that folder.`;
          if (!(await previewRoots(ctx.cwd)).roots.includes(root)) associate(root);
          if (baseline && !baseline.some(entry => entry.root === root)) baseline.push({ root, before: await snapshot(root) });
          const count = await shownPaths(root, await headCommit(root)).then(paths => paths.length, () => undefined);
          if (!count) return `Watching ${root} for this session; it has ${count === 0 ? 'no changes' : 'no readable status'} to show yet.`;
          await serial(async () => { await pick({ key: `diff:${root}`, root }); await render(); });
          return `Watching ${root} for this session; showing its diff.`;
        }
        if (await stat(file).then(info => info.isFile(), () => false)) {
          const warning = await edit(file, ctx);
          return [`Showing ${basename(file)} in the editor.`, warning].filter(Boolean).join(' ');
        }
        const tabs = name.includes('/') ? [] : (await documents(owner)).filter(doc => basename(doc) === name);
        if (tabs.length > 1) return `${name} matches several documents; give its path: ${tabs.join(', ')}`;
        if (tabs.length === 1) {
          const warning = await edit(tabs[0], ctx);
          return [`Showing ${name} in the editor.`, warning].filter(Boolean).join(' ');
        }
        looked = file;
      }
      return serial(async () => {
        const { previews, visible } = await layout();
        const names = previews.map(preview => preview.name).join(', ') || 'none';
        if (looked) return `No preview, document tab or file named ${name} (no file at ${looked}). Open previews: ${names}`;
        if (!previews.length) return 'No previews are open.';
        const target = name
          ? previews.find(preview => preview.name === name || preview.label === name)
          : previews[(previews.indexOf(visible) + 1) % previews.length];
        // The named preview may have closed since it was looked up.
        if (!target) return `No preview named ${name}. Open previews: ${names}`;
        if (target.writing) return 'The editor is in the writing view; its Panels tab π Show agent brings it back beside Pi.';
        await bring(target, visible);
        await render();
        return `Showing ${target.label}. Open: ${names}`;
      });
    },
    // On session start: records this Pi's session and adopts previews a previous Pi of it left (claimSession).
    // Returns a warning about this session's other editors that could not simply be taken over.
    async claim(session) {
      if (!env.TMUX || !owner || !session) return;
      const { unanswered, unclear, kept } = await serial(() => claimSession(owner, session, { nvim }));
      held = unclear;
      return [
        unanswered.length && `Took over this session's editor from before (${unanswered.join(', ')}), but it is not answering; its text stays in that pane.`,
        unclear.length && `This session's editor from before (${unclear.map(editor => editor.id).join(', ')}) is in a pane still running something, so it was not taken over. ` +
          'No editor opens automatically until it closes; /edit opens one here.',
        kept.length && `This session's editor from before (${kept.join(', ')}) is still open in its own pane; this Pi keeps its current editor.`,
      ].filter(Boolean).join(' ') || undefined;
    },
    // Redraws this Pi's Panels row; called on session start and after selections made outside Pi.
    render: () => env.TMUX && owner ? serial(render) : undefined,
    newPrompt() { seen.clear(); dismissed.clear(); baseline = undefined; skillFiles = new Map(); },
    // Returns a warning, once per value, for a configured preview root that is not a Git repository.
    async before(event, ctx) {
      if (!available(ctx.mode) || READ_ONLY.has(event.toolName)) return;
      const file = toolPath(event, ctx.cwd);
      if (file) {
        const { roots } = await previewRoots(ctx.cwd);
        const listed = await worktreeList(roots);
        // An edit or write in another worktree of these repositories: watched from this call, so this
        // turn's change there shows too.
        // Where the write lands: the file's own canonical path (following a symlink), or for a new file its
        // folder's.
        const target = file && (existsSync(file) ? canonical(file) : join(canonical(dirname(file)), basename(file)));
        const there = target && [...listed].filter(path => !roots.includes(path) && target.startsWith(path + '/')).sort((a, b) => b.length - a.length)[0];
        const root = there && await repoRoot(there);
        if (root && !worktrees.includes(root)) {
          associate(root);
          if (baseline) baseline.push({ root, before: await snapshot(root) });
        }
      }
      // Skill documents become document tabs even outside the preview repositories, or ignored by Git.
      if (file && MARKDOWN.test(file) && !skillFiles.has(file)) skillFiles.set(file, await worktreeState(file));
      if (baseline) return;
      const { roots, missing, made } = await watched(ctx.cwd);
      if (roots.length) baseline = await Promise.all([...roots, ...made].map(async root => ({ root, before: await snapshot(root) })));
      const fresh = missing.filter(value => !warned.has(value));
      fresh.forEach(value => warned.add(value));
      if (fresh.length) return `pi.previewRoot is not a Git repository: ${fresh.join(', ')}`;
    },
    // Called once the turn's tool calls have all finished: parallel calls never see each other mid-flight.
    // Returns undefined when the turn changed nothing, else { notice, warning }: a notice when a preview
    // waits, a warning when documents were loaded but the Panels row could not be redrawn.
    async settle() {
      const call = baseline, touched = skillFiles;
      baseline = undefined;
      skillFiles = new Map();
      if (!call && !touched.size) return;
      const changes = [], skillDocs = [];
      for (const { root, before } of call ?? []) {
        const after = await snapshot(root);
        const paths = changedPaths(before, after);
        if (paths.length) changes.push({ root, paths, files: after.files });
      }
      for (const [file, before] of touched) {
        const after = await worktreeState(file);
        if (after !== before && after !== 'missing' && nvim && await isSkillDocument(file)) skillDocs.push({ root: dirname(file), file });
      }
      if (!changes.length && !skillDocs.length) return;
      return serial(async () => {
        const { notice, loaded } = await show(changes, skillDocs);
        const drawn = await renderPanels(owner, { nvim }).then(() => true, () => false);
        return { notice, warning: loaded && !drawn ? NOT_REDRAWN : undefined };
      });
    },
    // `signalled()`: whether a signal stopped Pi (tmux closing its pane, kill) rather than a quit it chose;
    // read in the queued step, after every listener of that signal has run.
    async close(mode, { signalled = () => false } = {}) {
      baseline = undefined;
      skillFiles = new Map();
      // Child Pi processes (reviewers, `pi -p`) inherit TMUX_PANE; only the terminal UI owns the panes.
      if (!env.TMUX || !owner || mode !== 'tui') return;
      await serial(async () => {
        // Pi quits the same way when a signal stops it (tmux closing its pane sends SIGHUP): that is not a
        // deliberate close, so the previews stay for a resume (releaseOrphans).
        if (signalled() || !await paneExists(owner)) return releaseOrphans({ leaving: { pane: owner, pid: process.pid } });
        // A parked editor comes beside Pi first, so unsaved text is not left in a hidden window; one in the
        // writing view leaves it.
        const first = await layout();
        const doc = first.previews.find(preview => preview.key === 'doc');
        if (doc?.writing) await setWriting(owner, false, { nvim }).catch(() => {});
        else if (doc) await bring(doc, first.visible).catch(() => {});
        const { previews } = await layout();
        for (const preview of previews.filter(preview => preview.key !== 'doc')) {
          await tmux('kill-pane', '-t', preview.id).catch(() => {});
          await dropSidebarOnly(preview.window);
        }
        // The editor exits only if nothing is unsaved; otherwise, or if it does not answer, it stays open.
        await withDocuments(owner, async () => {
          for (const preview of previews.filter(preview => preview.key === 'doc')) {
            const server = await docServer(preview.id);
            if (server && nvim) await remote(server, 'v:lua.PiMarkdownQuit()').catch(() => {});
          }
          await tmux('set-option', '-pu', '-t', owner, DOCS).catch(() => {});
        }).catch(() => {});
        // Pi is leaving: an editor kept for unsaved text stands alone, with no row pointing at this Pi, and
        // one that could not come beside Pi is an ordinary window, listed in the Windows row.
        for (const pane of [owner, ...previews.map(preview => preview.id)]) await tmux('set-option', '-pu', '-t', pane, PANELS).catch(() => {});
        for (const { window } of (await layout().catch(() => ({ previews: [] }))).previews.filter(preview => preview.window !== first.window)) {
          await tmux('set-option', '-wu', '-t', window, PREVIEW_WINDOW).catch(() => {});
          await tmux('set-option', '-wu', '-t', window, PANELS).catch(() => {});
        }
        await tmux('set-option', '-pu', '-t', owner, PI_OWNER).catch(() => {});
        await tmux('set-option', '-wu', '-t', owner, PANELS).catch(() => {});
        await tmux('set-option', '-wu', '-t', owner, PI_WINDOW).catch(() => {});
      });
    },
  };
}
