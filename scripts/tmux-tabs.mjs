// Clicks on the bottom tab rows of tmux/pi-tabs.conf, and Panels row redraws.
//   tmux-tabs.mjs ps%N <client>         show preview %N beside its Pi
//   tmux-tabs.mjs px%N <client>         close preview %N (an editor with unsaved text asks first)
//   tmux-tabs.mjs ds%P:ID <client>      show Pi %P's document with that id in its editor beside it
//   tmux-tabs.mjs dx%P:ID <client>      close that document (unsaved text asks first)
//   tmux-tabs.mjs menu ds%P:ID <client> right-click on that document's tab: a menu to open it on the left
//   tmux-tabs.mjs open-left %P:ID <client>     from that menu: the document on the left of the writing view
//   tmux-tabs.mjs close-file %P <hex path> save|discard <client>   from a document's close menu
//   tmux-tabs.mjs w@N <client>          close window @N after a menu confirms it
//   tmux-tabs.mjs wv%P <client>         turn Pi %P's writing view on or off (two documents, Pi unseen)
//   tmux-tabs.mjs refresh <owner> [gone]  redraw that Pi's Panels row, leaving out an exiting pane
//   tmux-tabs.mjs refresh-pane %N [gone]  the same for the Pi that owns preview %N now; `gone` leaves %N out
//   tmux-tabs.mjs close-doc %N save|discard <client>   from the editor's close menu
//   tmux-tabs.mjs kill-window @N <client>       from that menu
//   tmux-tabs.mjs sweep                 release previews whose Pi has gone without quitting (tmux hooks)
// Failures of an action the user clicked are shown on their client; redraws fail quietly.
// Menus are opened from this helper rather than a mouse binding: -M lets them take clicks and -O
// keeps the opening click's release from closing them.
import { basename } from 'node:path';
import {
  DIFF_OWNER, DOC_OWNER, PI_WINDOW, TABS, allPanes,
  bringBeside, closeDocument, docId, docServer, documents, dropSidebarOnly, editorState, findExecutable, layoutOf, paneExists, releaseOrphans,
  openOnLeft, remoteExpr, renderPanels, selectDocument, setWriting, tmux,
} from './lib/diff-pane.ts';

const nvim = findExecutable('nvim');
const [action, target, extra] = process.argv.slice(2);
// Runs this script again from a tmux command (menu item or confirmation).
const again = (...args) => `run-shell -b "'${process.execPath}' --no-warnings '${TABS}' ${args.join(' ')}"`;
// Only the final newline is removed: a leading empty field (tab-separated) must survive.
const show = async (format, pane) => (await tmux('display-message', '-p', '-t', pane, format)).replace(/\n$/, '');

async function ownerOf(pane) {
  const [diff, doc] = (await show(`#{${DIFF_OWNER}}\t#{${DOC_OWNER}}`, pane)).split('\t');
  return { owner: diff || doc, doc: Boolean(doc) };
}

// A short message on the clicking client's status line.
const notice = (client, text) => tmux('display-message', '-c', client, '-d', '5000', text.replaceAll('#', '##'));

// A tab can outlive its pane when a preview started by an older version exits without redrawing the
// row. Redraw the row of the Pi the client is looking at (its pane, the Pi of its preview, or the only
// Pi in its window) so the tab goes, and say so.
async function staleTab(client) {
  const pane = (await tmux('display-message', '-p', '-c', client, '#{pane_id}')).trim();
  const [flag, diff, doc, window] = (await show(`#{@pi_owner}\t#{${DIFF_OWNER}}\t#{${DOC_OWNER}}\t#{window_id}`, pane)).split('\t');
  let owner = flag ? pane : diff || doc;
  if (!owner) {
    const pis = (await tmux('list-panes', '-t', window, '-F', '#{pane_id}\t#{@pi_owner}')).split('\n')
      .map(line => line.split('\t')).filter(([, mark]) => mark).map(([id]) => id);
    if (pis.length === 1) [owner] = pis;
  }
  if (owner) await renderPanels(owner, { nvim });
  await tmux('display-message', '-c', client, '-d', '4000', 'That preview had already closed');
}

// Undefined when nothing is unsaved, else a description such as 'notes.md (+1 more)'. Throws when the
// editor does not answer.
async function unsaved(pane) {
  const state = await editorState(nvim, pane);
  if (!state) throw new Error('the editor is not answering');
  if (!state.modified) return undefined;
  return `${state.current ? basename(state.current) : 'the editor'}${state.modified > 1 ? ` (+${state.modified - 1} more)` : ''}`;
}

// Within the client's own session: given only a window, tmux picks the most recently active
// session showing it, which can be another terminal's view (scripts/tmux-view.sh).
async function showWindow(client, window) {
  const session = (await tmux('list-clients', '-F', '#{client_name}\t#{session_id}')).split('\n')
    .map(line => line.split('\t')).find(([name]) => name === client)?.[1];
  await tmux('switch-client', '-c', client, '-t', session ? `${session}:${window}` : window);
}

async function select(pane, client) {
  if (!await paneExists(pane)) return staleTab(client);
  const { owner } = await ownerOf(pane);
  if (!owner) return;
  const { previews, visible, window } = await layoutOf(owner);
  const preview = previews.find(candidate => candidate.id === pane);
  if (preview) await bringBeside(owner, preview, visible);
  await renderPanels(owner, { nvim });
  await showWindow(client, window);
}

async function close(pane, client) {
  if (!await paneExists(pane)) return staleTab(client);
  const { owner, doc } = await ownerOf(pane);
  if (!owner) return;
  if (doc) {
    // Unsaved text is never discarded without a choice; Escape or the first item keeps editing.
    // An editor that does not answer is treated as unsaved.
    const file = await unsaved(pane).catch(() => 'the editor (not answering)');
    if (file) {
      // Drawn on the clicking client's own screen; the editor may be in a window it is not showing.
      await tmux('display-menu', '-O', '-M', '-c', client, '-x', 'C', '-y', 'S', '-T', `Unsaved changes in ${file}`.replaceAll('#', '##'), '--',
        'Keep editing', 'k', '',
        'Save and close', 's', again('close-doc', pane, 'save', client),
        'Discard and close', 'd', again('close-doc', pane, 'discard', client));
      return;
    }
    await remoteExpr(nvim, await docServer(pane), 'v:lua.PiMarkdownQuit()');
    return;
  }
  const window = await show('#{window_id}', pane);
  await tmux('kill-pane', '-t', pane);
  await dropSidebarOnly(window);
  await renderPanels(owner, { nvim }).catch(() => {});
}

async function confirmWindow(window, client) {
  const name = await show('#{window_index}:#{window_name}', window);
  const pi = await show(`#{${PI_WINDOW}}`, window);
  const running = [...new Set((await tmux('list-panes', '-t', window, '-F', '#{pane_current_command}')).split('\n').filter(Boolean))];
  const ending = pi ? 'This ends the running Pi session.' : `This ends: ${running.join(', ')}.`;
  // The same menu as the editor's close: keeping the window is first and what Escape does.
  await tmux('display-menu', '-O', '-M', '-c', client, '-x', 'C', '-y', 'S', '-T', `Close window ${name}? ${ending}`.replaceAll('#', '##'), '--',
    'Keep window', 'k', '',
    'Close window', 'c', again('kill-window', window, client));
}

// An editor with unsaved text in the window moves to its own window first. Previews of a Pi that ran
// there stay for a resume of its session, as ordinary windows (releaseOrphans).
async function killWindow(window) {
  const rows = await allPanes(`#{pane_id}\t#{window_id}\t#{${DOC_OWNER}}`);
  for (const [id, inWindow, doc] of rows) {
    if (inWindow === window && doc && await unsaved(id).catch(() => true)) await tmux('break-pane', '-d', '-s', id, '-n', 'edit');
  }
  await tmux('kill-window', '-t', window);
  await releaseOrphans();
}

// A preview's owner is read from its pane, not fixed when it started: a restarted Pi may have adopted it.
async function refreshOwnerOf(pane, gone) {
  const { owner } = await ownerOf(pane);
  if (owner) await renderPanels(owner, { nvim, gone: gone ? pane : undefined });
}

// The editor's own result (saved, not saved and why, discarded) is shown on the client.
// Document tabs name their Pi and the document's id; a tab whose document has gone matches nothing.
async function documentAt(range) {
  const [owner, id] = range.split(':');
  return { owner, file: (await documents(owner)).find(file => docId(file) === id) };
}

async function selectDoc(range, client) {
  const { owner, file } = await documentAt(range);
  if (!file) return;
  const { window, warning } = await selectDocument(owner, file, { nvim });
  await showWindow(client, window);
  if (warning) await notice(client, warning);
}

// Where to open a document: only placements, so a right-click never offers to end Pi. Escape cancels.
async function documentMenu(range, client) {
  const { file } = await documentAt(range);
  if (!file) return;
  await tmux('display-menu', '-O', '-M', '-c', client, '-x', 'C', '-y', 'S', '-T', basename(file).replaceAll('#', '##'), '--',
    'Open on left', 'l', again('open-left', range, client));
}

async function openLeft(range, client) {
  const { owner, file } = await documentAt(range);
  if (!file) return;
  const { window, message, warning } = await openOnLeft(owner, file, { nvim });
  if (window) await showWindow(client, window);
  if (message || warning) await notice(client, message ?? warning);
}

async function toggleWriting(owner, client) {
  const { window, message, warning } = await setWriting(owner, undefined, { nvim });
  if (window) await showWindow(client, window);
  if (message || warning) await notice(client, message ?? warning);
}

// A document with unsaved text in the editor, or an editor that does not answer, asks first; any
// other document closes at once. Other documents are untouched. The menu is shown after the lock is
// released; its choice runs as a new close-file action.
async function closeDocTab(range, client) {
  const { owner, file } = await documentAt(range);
  if (!file) return renderPanels(owner, { nvim }).catch(() => {});
  // Not closed changes nothing, so a failed redraw then hides nothing.
  const { closed, warning } = await closeDocument(owner, file, 'close', { nvim });
  if (closed) return warning && notice(client, warning);
  const pathHex = Buffer.from(file).toString('hex');
  await tmux('display-menu', '-O', '-M', '-c', client, '-x', 'C', '-y', 'S', '-T', `Unsaved changes in ${file.split('/').pop()}`.replaceAll('#', '##'), '--',
    'Keep editing', 'k', '',
    'Save and close', 's', again('close-file', owner, pathHex, 'save', client),
    'Discard and close', 'd', again('close-file', owner, pathHex, 'discard', client));
}

async function closeFile(owner, pathHex, how, client) {
  const { message, warning } = await closeDocument(owner, Buffer.from(pathHex, 'hex').toString(), how, { nvim });
  await notice(client, warning ? `${message}. ${warning}` : message);
}

async function closeDoc(pane, how, client) {
  await notice(client, await remoteExpr(nvim, await docServer(pane), `v:lua.PiMarkdownClose('${how === 'discard' ? 'discard' : 'save'}')`));
}

// The clicking client: last argument of the follow-up actions, second of a click.
const client = { 'close-doc': process.argv[5], 'close-file': process.argv[6], 'kill-window': extra, menu: extra, 'open-left': extra }[action] ?? target;
try {
  if (action?.startsWith('ps%')) await select(action.slice(2), target);
  else if (action?.startsWith('px%')) await close(action.slice(2), target);
  else if (action === 'menu' && target?.startsWith('ds%')) await documentMenu(target.slice(2), extra);
  else if (action === 'open-left') await openLeft(target, extra);
  else if (action?.startsWith('wv%')) await toggleWriting(action.slice(2), target);
  else if (action?.startsWith('w@')) await confirmWindow(action.slice(1), target);
  else if (action?.startsWith('ds%')) await selectDoc(action.slice(2), target);
  else if (action?.startsWith('dx%')) await closeDocTab(action.slice(2), target);
  else if (action === 'close-file') await closeFile(target, extra, process.argv[5], process.argv[6]);
  else if (action === 'refresh') await renderPanels(target, { nvim, gone: extra }).catch(() => {});
  else if (action === 'refresh-pane') await refreshOwnerOf(target, extra === 'gone').catch(() => {});
  else if (action === 'close-doc') await closeDoc(target, extra, process.argv[5]);
  else if (action === 'kill-window') await killWindow(target);
  else if (action === 'sweep') await releaseOrphans().catch(() => {});
} catch (error) {
  if (!action?.startsWith('refresh') && action !== 'sweep' && client) {
    const message = String(error?.stderr || error?.message || error).trim().split('\n')[0];
    await tmux('display-message', '-c', client, '-d', '5000', `Tab action failed: ${message}`.replaceAll('#', '##')).catch(() => {});
  }
}
