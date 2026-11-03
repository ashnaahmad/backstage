import { Type } from '@earendil-works/pi-ai';
import { DynamicBorder, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Container, Input, Spacer, Text, fuzzyFilter, getKeybindings } from '@earendil-works/pi-tui';
// TypeScript, not .mjs: Pi's loader imports .mjs natively, and Node keeps that module across /reload.
import { createDiffPane } from '../../scripts/lib/diff-pane.ts';

// Session entry recording a worktree that is this session's (see `worktrees` in scripts/lib/diff-pane.ts).
// Entries of the earlier 'harness-spawned-worktree' type are not read: any worktree that appeared during
// a turn was recorded there, whoever made it.
const WORKTREE_ENTRY = 'harness-session-worktree';

/**
 * Opens a live Hunk diff, or an editable Neovim for changed Markdown, beside Pi in tmux after a turn changes the
 * repository or one named by `pi.previewRoot`. One preview is shown at a time. With tmux/pi-tabs.conf, the
 * Panels tab row at the bottom switches and closes them; /panels (a searchable selector, as /model's) and
 * /panel (cycle or by name) also switch.
 * The show_panel tool lets the agent do what /panel does, so it can open a document instead of asking the user to.
 */
// The /panels selector, in the style of /model's: type to filter, ↑↓ to move, Enter to show, Esc to cancel.
// Previews and this Pi's documents come first, then other Markdown with where it is.
function panelSelector(list, theme, done) {
  // The theme Pi passes in, not its global one (unset outside Pi's terminal UI).
  const border = () => new DynamicBorder(text => theme.fg('border', text));
  const box = new Container() as Container & { focused: boolean; handleInput(data: string): void };
  const search = new Input();
  const rows = new Container();
  let shown = list, selected = 0;
  const label = entry => [entry.state, entry.place].filter(Boolean).join(', ');
  const draw = () => {
    rows.clear();
    if (!shown.length) { rows.addChild(new Text(theme.fg('muted', '  No matches'), 0, 0)); return; }
    const visible = 10;
    const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), shown.length - visible));
    for (let i = start; i < Math.min(start + visible, shown.length); i++) {
      const entry = shown[i], here = i === selected;
      const name = !entry.enabled ? theme.fg('dim', entry.name) : here ? theme.fg('accent', entry.name) : entry.name;
      const where = entry.file ? theme.fg('muted', ` ${entry.location}`) : '';
      const state = label(entry) ? theme.fg('muted', ` · ${label(entry)}`) : '';
      rows.addChild(new Text(`${here ? theme.fg('accent', '→ ') : '  '}${name}${where}${state}`, 0, 0));
    }
    if (shown.length > visible) rows.addChild(new Text(theme.fg('muted', `  (${selected + 1}/${shown.length})`), 0, 0));
  };
  const filter = () => {
    const query = search.getValue();
    shown = query ? fuzzyFilter(list, query, entry => `${entry.name} ${entry.location ?? ''}`) : list;
    selected = 0;
    draw();
  };
  const choose = () => { if (shown[selected]?.enabled) done(shown[selected]); };
  search.onSubmit = choose;
  box.addChild(border());
  box.addChild(new Spacer(1));
  box.addChild(new Text(theme.fg('accent', theme.bold('Show beside Pi')), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(search);
  box.addChild(new Spacer(1));
  box.addChild(rows);
  box.addChild(new Spacer(1));
  box.addChild(new Text(theme.fg('dim', '  type to filter · ↑↓ navigate · enter show · esc cancel'), 0, 0));
  box.addChild(border());
  // The search box shows the cursor while the selector has focus.
  Object.defineProperty(box, 'focused', { get: () => search.focused, set: value => { search.focused = value; } });
  box.handleInput = data => {
    const keys = getKeybindings();
    if (keys.matches(data, 'tui.select.up')) { if (shown.length) selected = selected ? selected - 1 : shown.length - 1; draw(); }
    else if (keys.matches(data, 'tui.select.down')) { if (shown.length) selected = (selected + 1) % shown.length; draw(); }
    else if (keys.matches(data, 'tui.select.confirm')) choose();
    else if (keys.matches(data, 'tui.select.cancel')) done(undefined);
    else { search.handleInput(data); filter(); }
  };
  draw();
  return box;
}

export default function diffPane(pi: ExtensionAPI) {
  const pane = createDiffPane();
  const SIGNALS = ['SIGHUP', 'SIGTERM'];
  let signalled = false, listening = false;
  const onSignal = () => { signalled = true; };
  // Records worktrees that became this session's (an edit there, or chosen with /panel or show_panel).
  const record = () => { for (const root of pane.takeAssociated()) pi.appendEntry(WORKTREE_ENTRY, { root }); };
  const report = (ctx, error) => ctx.hasUI && ctx.ui.notify(`Diff pane: ${String(error)}`, 'warning');
  // A change that took effect while its Panels tab row could not be redrawn.
  const warn = (ctx, warning) => warning && ctx.hasUI && ctx.ui.notify(warning, 'warning');
  pi.registerCommand('edit', {
    description: 'Open a file in the editable Markdown side pane',
    handler: async (args, ctx) => {
      const path = args.trim().replace(/^(["'])(.*)\1$/, '$2');
      if (!path) {
        ctx.ui.notify('Usage: /edit path/to/file.md', 'info');
        return;
      }
      try { warn(ctx, await pane.edit(path, ctx)); } catch (error) { report(ctx, error); }
    },
  });
  pi.registerCommand('create', {
    description: 'Create an empty file (never overwriting) and open it in the editable Markdown side pane',
    handler: async (args, ctx) => {
      const path = args.trim().replace(/^(["'])(.*)\1$/, '$2');
      if (!path) {
        ctx.ui.notify('Usage: /create path/to/file.md', 'info');
        return;
      }
      try { warn(ctx, await pane.create(path, ctx)); } catch (error) { report(ctx, error); }
    },
  });
  pi.registerCommand('panel', {
    description: 'Show the next preview beside Pi, or one by name: /panel edit, /panel <repository>, /panel <document path or tab name>, ' +
      '/panel <worktree folder> (watches a worktree as this session\'s)',
    handler: async (args, ctx) => {
      const name = args.trim().replace(/^(["'])(.*)\1$/, '$2');
      try { ctx.ui.notify(await pane.panel(name, ctx), 'info'); } catch (error) { report(ctx, error); } finally { record(); }
    },
  });
  pi.registerTool({
    name: 'show_panel',
    label: 'Show panel',
    description: 'Show a document or diff preview to the user in the side pane beside Pi (as the /panel command does). ' +
      'Give a file path (relative to the working directory, or absolute) to open it in the editable Markdown editor, ' +
      'the name of an open document tab, "edit" for the editor, or a repository name for its diff. Omit name to cycle to the next preview. ' +
      'Give the top-level folder of a Git worktree you created or are working in (by a command, script or handoff) to make it this ' +
      'session\'s: its diff is shown and watched after your turns, across reload and resume. Do this after creating a worktree, ' +
      'unless you edit or write its files with your own tools, which selects it already. ' +
      'Use this instead of asking the user to run /edit or /panel. Unsaved text in the editor is kept; focus stays in Pi.',
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'File path, document tab name, "edit", repository name, or worktree folder path.' })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      let text;
      try { text = await pane.panel((params.name ?? '').trim(), ctx); } finally { record(); }
      return { content: [{ type: 'text', text }], details: {} };
    },
  });
  pi.registerCommand('panels', {
    description: 'Choose what is shown beside Pi: a repository diff, a document, or any Markdown file here, in watched repositories or the parent folder',
    handler: async (_args, ctx) => {
      try {
        const list = await pane.choices(ctx);
        if (!list.length) { ctx.ui.notify('No repository or Markdown file to show here.', 'info'); return; }
        const entry = await ctx.ui.custom((_tui, theme, _keys, done) => panelSelector(list, theme, done));
        const warning = entry && await pane.showChoice(entry, ctx);
        if (warning) ctx.ui.notify(warning, 'warning');
      } catch (error) { report(ctx, error); }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    // This session's worktrees, still watched and listed by /panels after a reload or resume.
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    pane.setWorktrees(entries.filter(entry => entry.type === 'custom' && entry.customType === WORKTREE_ENTRY)
      .map(entry => entry.data?.root).filter(Boolean));
    // A signal stops Pi through the same quit as /quit: a quit Pi chose closes its previews, a signal
    // (tmux closing its pane, kill) leaves them for a resume. Node runs every listener of a signal before
    // any promise callback, so the flag is set when close() reads it in its queued step. Only in the
    // terminal UI: elsewhere Pi may not handle these signals, and a listener would keep them from ending
    // the process.
    if (ctx.mode === 'tui' && !listening) {
      for (const signal of SIGNALS) process.on(signal, onSignal);
      listening = true;
    }
    if (ctx.mode === 'tui' && process.env.TMUX && !pane.hunk) {
      ctx.ui.notify('Diff pane disabled: install Hunk (brew install hunk).', 'info');
    } else if (ctx.mode === 'tui' && process.env.TMUX && !pane.nvim) {
      ctx.ui.notify('Markdown editor disabled: install Neovim (see SETUP.md); Markdown changes open in Hunk.', 'info');
    }
    // Takes back previews this session's earlier Pi left (restarted or resumed elsewhere), then marks this
    // window as Pi's and draws its Panels row (tmux/pi-tabs.conf). New, resumed and forked sessions in
    // this pane keep its previews, which then belong to the new session.
    if (ctx.mode === 'tui') try {
      const warning = await pane.claim(ctx.sessionManager?.getSessionId());
      if (warning && ctx.hasUI) ctx.ui.notify(warning, 'warning');
      await pane.render();
    } catch (error) { report(ctx, error); }
  });
  pi.on('before_agent_start', async () => pane.newPrompt());
  pi.on('tool_call', async (event, ctx) => {
    try {
      const warning = await pane.before(event, ctx);
      if (warning) report(ctx, warning);
    } catch (error) { report(ctx, error); }
  });
  // After every tool call in the turn has finished; returns nothing, so the turn is unchanged.
  pi.on('turn_end', async (_event, ctx) => {
    try {
      const settled = await pane.settle();
      record();
      if (settled?.notice && ctx.hasUI) ctx.ui.notify(settled.notice, 'info');
      warn(ctx, settled?.warning);
    } catch (error) { report(ctx, error); }
  });
  pi.on('session_shutdown', async (event, ctx) => {
    // Reload and session replacement keep the panes; the next runtime adopts them by their owner tags.
    if (event.reason !== 'quit') {
      for (const signal of SIGNALS) process.off(signal, onSignal);
      listening = false;
      return;
    }
    try { await pane.close(ctx.mode, { signalled: () => signalled }); } catch (error) { report(ctx, error); }
  });
}
