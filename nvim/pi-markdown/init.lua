-- Isolated Markdown editor beside Pi. Started as `NVIM_APPNAME=pi-markdown nvim -u <this file>`,
-- so it reads no personal Vim/Neovim configuration; scripts/install-markdown-editor.sh installs
-- the pinned renderer under stdpath('data'). Unsaved edits are never discarded or saved for you:
-- a clean buffer follows the file on disk; a modified one keeps your text and shows a warning,
-- and Neovim's own write check asks before overwriting a file that changed since it was read.
vim.o.autoread = true
-- Switching documents keeps a buffer's unsaved text (Neovim's default, relied on by the Panels tabs).
vim.o.hidden = true
vim.o.wrap = true
-- Scroll by screen line. The renderer fits wide tables to the window by drawing each row as several
-- virtual lines; scrolling by buffer line could not move back above such a table (wheel or Ctrl-Y).
vim.o.smoothscroll = true
vim.o.linebreak = true
vim.o.number = false
vim.o.signcolumn = 'no'
vim.o.laststatus = 0
vim.o.shortmess = vim.o.shortmess .. 'I'

-- Match Hunk's close key without requiring a shifted colon. Insert-mode q remains text.
-- `qall`: the command index above the document is a window too, and closes with it.
vim.keymap.set('n', 'w', '<Cmd>write<CR>', { desc = 'Save Markdown' })
vim.keymap.set('n', 'q', '<Cmd>confirm qall<CR>', { desc = 'Close Markdown editor' })
-- Text selected by dragging the mouse: Backspace (the Mac delete key) deletes it, as in other editors,
-- rather than moving the cursor. From typing, the deletion returns to typing.
vim.keymap.set('x', '<BS>', '"_d', { desc = 'Delete the selection' })
-- While typing, only Esc stops typing. A drag or double/triple click would otherwise switch to Visual
-- mode, where the next letter typed runs as a command. Select mode instead replaces the selection with
-- what is typed, and the delete key removes it, both continuing to type. Outside typing, mouse
-- selections stay Visual, for Vim commands.
vim.api.nvim_create_autocmd('ModeChanged', { pattern = '*:i', callback = function() vim.o.selectmode = 'mouse' end })
vim.api.nvim_create_autocmd('ModeChanged', { pattern = '*:n', callback = function() vim.o.selectmode = '' end })

-- One clipboard, shared with other apps and with the editor in every other panel (each its own Neovim):
-- copying (`y`) and cutting (`dd`, `d` or `c` with a motion) put text there, and `p` pastes from it.
-- The delete key, `x` and typing over a selection only delete, as in other editors; they use Neovim's
-- own register, so selecting text while typing and pasting replaces it with what was copied.
-- The terminal's Cmd-C and right-click Copy see no selection, since the mouse belongs to Neovim. Outside
-- typing, a mouse selection is copied when the button is released and stays selected.
vim.keymap.set('n', 'x', '"_x', { desc = 'Delete a letter' })
vim.keymap.set({ 'n', 'x' }, 'p', '"+p', { desc = 'Paste the clipboard' })
vim.keymap.set({ 'n', 'x' }, 'P', '"+P', { desc = 'Paste the clipboard before the cursor' })
vim.api.nvim_create_autocmd('TextYankPost', {
  callback = function()
    local event = vim.v.event
    if event.regname == '' and (event.operator == 'y' or not event.visual) then
      vim.fn.setreg('+', event.regcontents, event.regtype)
    end
  end,
})

local function copy_selection()
  local mode = vim.fn.mode()
  if not mode:match('^[vV\22]$') then return end
  local lines = vim.fn.getregion(vim.fn.getpos('v'), vim.fn.getpos('.'), { type = mode })
  vim.fn.setreg('+', lines, mode == 'V' and 'l' or mode == 'v' and 'c' or 'b')
end
for _, release in ipairs({ '<LeftRelease>', '<2-LeftRelease>', '<3-LeftRelease>', '<4-LeftRelease>' }) do
  vim.keymap.set('x', release, function()
    vim.schedule(copy_selection)
    return release
  end, { expr = true, desc = 'Copy the mouse selection' })
end

local ok, render = pcall(require, 'render-markdown')
if ok then
  -- Plain glyphs: the default heading, checkbox, link and callout icons need a Nerd Font.
  local callouts = {}
  for name, callout in pairs(require('render-markdown.settings').callout.default) do
    callouts[name] = { rendered = callout.rendered:gsub('^%S+ ', '') }
  end
  render.setup({
    heading = { icons = { '# ', '## ', '### ', '#### ', '##### ', '###### ' }, sign = false },
    checkbox = { unchecked = { icon = '☐ ' }, checked = { icon = '☑ ' }, custom = { todo = { rendered = '◐ ' } } },
    link = { enabled = false },
    callout = callouts,
    -- Outside typing the cursor's line stays rendered, as the rest of the document; by default its raw
    -- Markdown showed, so a table row became `|---|---|` between drawn borders. Typing shows raw text.
    anti_conceal = { enabled = false },
    win_options = { concealcursor = { rendered = 'nc' } },
  })
end

-- Size and mtime of a file, to notice disk changes while the buffer has unsaved edits.
local function disk(name)
  local info = vim.uv.fs_stat(name)
  return info and table.concat({ info.size, info.mtime.sec, info.mtime.nsec }, ':') or 'missing'
end
local function file_buffer(buf)
  return vim.bo[buf].buftype == '' and vim.api.nvim_buf_get_name(buf) ~= ''
end

-- A file changed on disk is handled without Neovim's W12 prompt, which blocks redrawing and remote
-- calls until answered, so tabs would switch buffers behind a frozen screen. A clean buffer reloads;
-- one with unsaved text keeps it, and the bar says the file changed on disk (`:w` still asks).
vim.api.nvim_create_autocmd('FileChangedShell', {
  callback = function(args)
    vim.v.fcs_choice = vim.bo[args.buf].modified and '' or 'reload'
  end,
})

-- Not FileChangedShellPost: keeping your edits must not clear the changed-on-disk warning.
vim.api.nvim_create_autocmd({ 'BufReadPost', 'BufWritePost' }, {
  callback = function(args)
    vim.b[args.buf].pi_disk = disk(vim.api.nvim_buf_get_name(args.buf))
    vim.b[args.buf].pi_note = nil
  end,
})

-- Index of common commands, fixed above the document for anyone new to Vim: outside typing, every
-- key is a command. Read-only and never focused (a click returns to the document); recreated if a
-- window command or a refused quit closed it. Its status line is the document's bar.
local HELP = {
  'Not typing? Every key is a command:',
  ' i  start typing      Esc  stop typing',
  ' w  save              q    close',
  ' u  undo              Ctrl-r  redo',
  ' x  delete a letter   dd   cut the line',
  ' y  copy a selection (a mouse drag copies itself)',
  ' p  paste what was copied, here or elsewhere',
  ' /word Enter  find    n    next match',
  'Half-typed command or : line? Esc cancels it.',
}
local help_buf, help_win
-- The windows showing documents, left to right: one, or two side by side in the writing view
-- (PiMarkdownWrite).
local function document_windows()
  local docs = vim.tbl_filter(function(win)
    return win ~= help_win and vim.api.nvim_win_get_config(win).relative == ''
  end, vim.api.nvim_tabpage_list_wins(0))
  table.sort(docs, function(a, b) return vim.fn.win_screenpos(a)[2] < vim.fn.win_screenpos(b)[2] end)
  return docs
end
-- The document window with the cursor, else the first.
local function document_window()
  local docs, current = document_windows(), vim.api.nvim_get_current_win()
  return vim.tbl_contains(docs, current) and current or docs[1]
end

-- A document's name and state, or a warning. With one document it is the line between the index and the
-- document; in the writing view each side has its own beneath it, highlighted for the side with the cursor.
-- While a status line's %{} item is evaluated, the current window is the one it belongs to and
-- g:actual_curwin the one with the cursor (g:statusline_winid is set only for %!).
function PiMarkdownBar()
  local docs, win = document_windows(), vim.api.nvim_get_current_win()
  if not vim.tbl_contains(docs, win) then
    if #docs > 1 then return '%#StatusLineNC# Writing view: a Panels tab opens in the side with the cursor' end
    win = docs[1]
  end
  local buf = win and vim.api.nvim_win_get_buf(win) or vim.api.nvim_get_current_buf()
  local focused = #docs < 2 or win == tonumber(vim.g.actual_curwin)
  local name = vim.api.nvim_buf_get_name(buf)
  local notes = {}
  if not ok then table.insert(notes, 'Renderer missing: scripts/install-markdown-editor.sh') end
  if file_buffer(buf) and vim.b[buf].pi_disk and vim.b[buf].pi_disk ~= 'missing' and disk(name) == 'missing' then
    table.insert(notes, vim.bo[buf].modified and 'File removed from disk; your text is kept here' or 'File removed from disk; closing it')
  elseif file_buffer(buf) and vim.bo[buf].modified and vim.b[buf].pi_disk and disk(name) ~= vim.b[buf].pi_disk then
    table.insert(notes, 'Changed on disk; edits kept · :w asks · :e! loads disk')
  end
  if vim.bo[buf].modified and vim.b[buf].pi_note then table.insert(notes, vim.b[buf].pi_note) end
  if #notes > 0 then return '%#WarningMsg# ' .. table.concat(notes, ' · '):gsub('%%', '%%%%') end
  local shown = name == '' and '[No Name]' or vim.fn.fnamemodify(name, ':~')
  return (focused and '%#StatusLine#' or '%#StatusLineNC#') .. ' %<' .. shown:gsub('%%', '%%%%') .. (vim.bo[buf].modified and ' [+] unsaved' or '') .. ' '
end

local function fit_help()
  if help_win and vim.api.nvim_win_is_valid(help_win) then
    vim.api.nvim_win_set_height(help_win, vim.api.nvim_win_text_height(help_win, {}).all)
  end
end
local function show_help()
  if help_win and vim.api.nvim_win_is_valid(help_win) then return end
  if not document_window() then return end
  if not (help_buf and vim.api.nvim_buf_is_valid(help_buf)) then
    help_buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(help_buf, 0, -1, false, HELP)
    vim.bo[help_buf].modifiable = false
  end
  help_win = vim.api.nvim_open_win(help_buf, false, { split = 'above', win = -1, height = #HELP })
  for option, value in pairs({ winfixheight = true, winfixbuf = true, wrap = true, number = false, cursorline = false,
      winhighlight = 'Normal:Comment', statusline = '%{%v:lua.PiMarkdownBar()%}' }) do
    vim.wo[help_win][option] = value
  end
  fit_help()
end
-- Two documents side by side each need a bar beneath them; with one, the index's status line is its bar.
vim.o.statusline = '%{%v:lua.PiMarkdownBar()%}'
local function arrange() vim.o.laststatus = #document_windows() > 1 and 2 or 0 end
vim.api.nvim_create_autocmd({ 'WinNew', 'WinClosed' }, { callback = function() vim.schedule(arrange) end })
vim.api.nvim_create_autocmd('VimEnter', { callback = show_help })
vim.api.nvim_create_autocmd({ 'VimResized', 'WinResized' }, { callback = fit_help })
vim.api.nvim_create_autocmd({ 'BufModifiedSet', 'BufEnter', 'BufWritePost' }, { command = 'redrawstatus!' })
vim.api.nvim_create_autocmd('WinEnter', {
  callback = function()
    if vim.api.nvim_get_current_win() ~= help_win then return end
    local came = vim.fn.win_getid(vim.fn.winnr('#'))
    local doc = vim.tbl_contains(document_windows(), came) and came or document_window()
    if doc then vim.schedule(function() pcall(vim.api.nvim_set_current_win, doc) end) end
  end,
})
-- `:q` in the document: the index must not be left as the last window.
vim.api.nvim_create_autocmd('QuitPre', {
  callback = function()
    if help_win and vim.api.nvim_win_is_valid(help_win) and #vim.api.nvim_tabpage_list_wins(0) == 2 then
      vim.api.nvim_win_close(help_win, true)
    end
  end,
})

local close_document  -- below, with the remote calls

-- Self-correction once a document's folder or file is removed (a deleted worktree, say). Without a
-- working directory Neovim's path functions fail on every redraw, so it moves home. A clean document
-- whose file has been missing for three seconds closes, as its Panels tab's x would; one with unsaved
-- text stays, with a note in the bar. A brief removal (a checkout rewriting files) is waited out.
local missing = {}  -- buffer -> seconds its file has been missing
local function correct_removed()
  if not vim.uv.cwd() then pcall(vim.fn.chdir, vim.env.HOME or '/') end
  local current = vim.api.nvim_get_current_buf()
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    local read = vim.b[buf].pi_disk and vim.b[buf].pi_disk ~= 'missing'
    if vim.bo[buf].buflisted and file_buffer(buf) and read and not vim.bo[buf].modified
        and disk(vim.api.nvim_buf_get_name(buf)) == 'missing' then
      missing[buf] = (missing[buf] or 0) + 1
    else
      missing[buf] = nil
    end
  end
  for buf, seconds in pairs(missing) do
    if seconds >= 3 and (buf ~= current or vim.fn.mode(1) == 'n') then
      missing[buf] = nil
      pcall(close_document, buf, 'close')
    end
  end
end

-- A clean buffer on screen (either side of the writing view) reloads changes from disk; a modified one
-- is left alone.
vim.uv.new_timer():start(1000, 1000, vim.schedule_wrap(function()
  correct_removed()
  for _, win in ipairs(document_windows()) do
    local buf = vim.api.nvim_win_get_buf(win)
    if file_buffer(buf) and not vim.bo[buf].modified and vim.fn.mode(1) == 'n' then
      vim.cmd.checktime(buf)
    end
  end
  if vim.v.vim_did_enter == 1 then show_help() end
  vim.cmd('redrawstatus!')  -- the bar is the index window's status line, not the current window's
end))

-- Remote calls from the Pi extension; paths arrive hex-encoded to avoid quoting.
local function decode(hex) return (hex:gsub('%x%x', function(h) return string.char(tonumber(h, 16)) end)) end

local function same_file(buf, path)
  local name = vim.api.nvim_buf_get_name(buf)
  return name ~= '' and (vim.uv.fs_realpath(name) or name) == (vim.uv.fs_realpath(path) or path)
end
-- The listed buffer for `path`, added without loading it if there is none. An existing one is reused
-- before `:badd`, which refuses the current buffer while it holds unsaved text (E37).
local function buffer_for(path)
  local function find()
    for _, buf in ipairs(vim.api.nvim_list_bufs()) do
      if vim.bo[buf].buflisted and same_file(buf, path) then return buf end
    end
  end
  local found = find()
  if found then return found end
  vim.cmd.badd(vim.fn.fnameescape(path))
  return find()
end
local function shown_in(path)
  for _, win in ipairs(document_windows()) do
    if same_file(vim.api.nvim_win_get_buf(win), path) then return win end
  end
end

-- An agent change does not take the view from a buffer with unsaved text: the document is loaded
-- behind it and noted. An explicit choice (a Panels tab, /edit, /panels) switches; the buffer left
-- keeps its unsaved text. Either way, the document with the cursor is the one replaced, and one
-- already on screen (the other side of the writing view) is left where it is. `explicit` 2 is a choice
-- in the writing view: a document on screen gets the cursor. Only Open on left (PiMarkdownOpenLeft) adds a side.
function PiMarkdownOpen(hex, explicit)
  local path = decode(hex)
  local doc = document_window()
  if doc and vim.api.nvim_get_current_win() ~= doc then vim.api.nvim_set_current_win(doc) end
  local buf = vim.api.nvim_get_current_buf()
  local there = shown_in(path)
  if there then
    if explicit ~= 2 or there == doc then return 'current' end
    vim.api.nvim_set_current_win(there)
    return 'focused'
  end
  if vim.bo[buf].modified and explicit ~= 1 and explicit ~= 2 then
    vim.cmd.badd(vim.fn.fnameescape(path))
    local here = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(buf), ':h')
    vim.b[buf].pi_note = 'Also requested: ' .. vim.fn.fnamemodify(path, vim.fn.fnamemodify(path, ':h') == here and ':t' or ':~')
    return 'kept'
  end
  vim.cmd.edit(vim.fn.fnameescape(path))
  return 'opened'
end

-- From the × on a document's Panels tab. `how` is 'close' (never drops unsaved text), 'save' or
-- 'discard', the last two chosen in tmux's menu. Other documents are untouched; when none is left
-- the editor quits, unless something else is unsaved. Returns what happened, which tmux shows.
function PiMarkdownCloseDoc(hex, how)
  local path = decode(hex)
  local target
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if same_file(buf, path) then target = buf end
  end
  if not target then return 'Closed ' .. vim.fn.fnamemodify(path, ':t') end
  return close_document(target, how)
end

function close_document(target, how)
  local short = vim.fn.fnamemodify(vim.api.nvim_buf_get_name(target), ':t')
  local done = 'Closed '
  if vim.bo[target].modified then
    local name = vim.api.nvim_buf_get_name(target)
    if how == 'save' then
      if vim.b[target].pi_disk and disk(name) ~= vim.b[target].pi_disk then
        return 'Not saved: ' .. short .. ' changed on disk; still open (:w asks, :e! loads disk)'
      end
      local ok, err = pcall(vim.api.nvim_buf_call, target, function() vim.cmd('silent write') end)
      if not ok then return 'Not saved: ' .. short .. ': ' .. tostring(err):gsub('^.-:E', 'E') .. '; still open' end
      done = 'Saved and closed '
    elseif how == 'discard' then
      done = 'Discarded '
    else
      return 'Unsaved: ' .. short .. '; still open'
    end
  end
  local others = vim.tbl_filter(function(buf)
    return buf ~= target and vim.bo[buf].buflisted and vim.api.nvim_buf_get_name(buf) ~= ''
  end, vim.api.nvim_list_bufs())
  -- Each window showing it takes another document not on screen; when there is none, a second side
  -- closes rather than repeat the other's document. Deleting a buffer on screen would close its window.
  if #others > 0 then
    for _, win in ipairs(document_windows()) do
      if vim.api.nvim_win_get_buf(win) == target then
        local on_screen = vim.tbl_map(vim.api.nvim_win_get_buf, document_windows())
        local spare = vim.tbl_filter(function(buf) return not vim.tbl_contains(on_screen, buf) end, others)[1]
        if spare then vim.api.nvim_win_set_buf(win, spare)
        elseif #document_windows() > 1 then vim.api.nvim_win_close(win, true)
        else vim.api.nvim_win_set_buf(win, others[1]) end
      end
    end
  end
  vim.api.nvim_buf_delete(target, { force = how == 'discard' })
  if #others == 0 then vim.schedule(function() pcall(vim.cmd, 'qall') end) end
  return done .. short
end

-- Buffers holding unsaved text: modified documents and typed text in an unnamed buffer, never the
-- command index (a scratch buffer). The one rule for Pi, the tabs and closing (PiMarkdownState).
local function unsaved_buffers()
  return vim.tbl_filter(function(buf) return vim.bo[buf].modified end, vim.api.nvim_list_bufs())
end

-- The editor's state for Pi and the tabs: the current file, the unsaved files, and how many buffers
-- hold unsaved text (unnamed ones included).
function PiMarkdownState()
  local unsaved = unsaved_buffers()
  local files = {}
  for _, buf in ipairs(unsaved) do
    local name = vim.api.nvim_buf_get_name(buf)
    if name ~= '' then table.insert(files, name) end
  end
  local shown = {}
  for _, win in ipairs(document_windows()) do
    local name = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win))
    if name ~= '' then table.insert(shown, name) end
  end
  -- Every file it holds, on screen or behind: each is one of Pi's documents (drawPanels).
  local open = {}
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].buflisted and file_buffer(buf) then table.insert(open, vim.api.nvim_buf_get_name(buf)) end
  end
  local doc = document_window()
  local current = doc and vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(doc)) or ''
  return vim.fn.json_encode({ current = current ~= '' and vim.fn.fnamemodify(current, ':p') or '', shown = shown,
    open = open, unsaved = files, modified = #unsaved })
end

-- The writing view (scripts/lib/diff-pane.ts, setWriting): the editor without Pi beside it, with one
-- document or two side by side. The right is the document that was beside Pi and stays there when Pi
-- returns (PiMarkdownSingle); the left, when there is one, takes Pi's place.
-- Only windows change: every buffer keeps its text.

-- A document for the left side other than `current`: the one shown before it, else `hex` (another of Pi's
-- documents, or empty), else `current` itself.
local function other_document(current, hex)
  local other = vim.fn.bufnr('#')
  if other > 0 and other ~= current and vim.bo[other].buflisted and file_buffer(other) then return other end
  local fallback = hex ~= '' and decode(hex) or ''
  if fallback ~= '' and not same_file(current, fallback) then return buffer_for(fallback) end
  return current
end

-- The ✎ Write switch: the editor as it is, now filling the screen; no side is added. A second document
-- comes only from Open on left.
function PiMarkdownWrite()
  return #document_windows() > 0 and 'writing' or 'no document'
end

-- Open on left (a document tab's menu): `path` on the left, with the cursor, and the right side kept. Asked for
-- the document already on the right, the sides swap rather than show it twice: the right takes the left's
-- document, or, from one side, another (as PiMarkdownWrite chooses, `hex` its fallback). Asked for the only
-- document there is, nothing changes ('alone').
function PiMarkdownOpenLeft(path_hex, hex)
  local path, docs = decode(path_hex), document_windows()
  if #docs == 0 then return 'no document' end
  local right = docs[#docs]
  local left = #docs > 1 and docs[1] or nil
  local file = buffer_for(path)
  if not left then
    local other = vim.api.nvim_win_get_buf(right) == file and other_document(file, hex) or nil
    if other == file then return 'alone' end
    left = vim.api.nvim_open_win(file, true, { split = 'left', win = right })
    if other then vim.api.nvim_win_set_buf(right, other) end
  elseif vim.api.nvim_win_get_buf(left) ~= file then
    if vim.api.nvim_win_get_buf(right) == file then vim.api.nvim_win_set_buf(right, vim.api.nvim_win_get_buf(left)) end
    vim.api.nvim_win_set_buf(left, file)
  end
  vim.api.nvim_set_current_win(left)
  arrange()
  return 'writing'
end

-- Back to one document beside Pi: the right side's, wherever the cursor was. The left window closes; its
-- buffer, saved or not, stays loaded behind it ('hidden'), as any document left by a tab click does.
function PiMarkdownSingle()
  local docs = document_windows()
  local keep = docs[#docs]
  for _, win in ipairs(docs) do
    if win ~= keep then vim.api.nvim_win_close(win, false) end
  end
  if keep then vim.api.nvim_set_current_win(keep) end
  arrange()
  return 'single'
end

function PiMarkdownQuit()
  if #unsaved_buffers() > 0 then
    vim.b[vim.api.nvim_get_current_buf()].pi_note = 'Pi exited; kept open for unsaved edits'
    return 'kept'
  end
  vim.schedule(function() vim.cmd('qall') end)
  return 'quit'
end

-- From the × on the editor's Panels tab, after the user chose in tmux's menu. Returns what happened,
-- which tmux shows. Saving writes each modified buffer, but never one whose file changed on disk since
-- it was read, and stops at the first failure; anything left unsaved keeps the editor open.
function PiMarkdownClose(how)
  if how == 'discard' then
    vim.schedule(function() vim.cmd('qall!') end)
    return 'Discarded and closed'
  end
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].modified and file_buffer(buf) then
      local name = vim.api.nvim_buf_get_name(buf)
      local short = vim.fn.fnamemodify(name, ':t')
      if vim.b[buf].pi_disk and disk(name) ~= vim.b[buf].pi_disk then
        return 'Not saved: ' .. short .. ' changed on disk; still open (:w asks, :e! loads disk)'
      end
      local ok, err = pcall(vim.api.nvim_buf_call, buf, function() vim.cmd('silent write') end)
      if not ok then return 'Not saved: ' .. short .. ': ' .. tostring(err):gsub('^.-:E', 'E') .. '; still open' end
    end
  end
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.bo[buf].modified then return 'Not saved: an unnamed buffer has text; still open' end
  end
  vim.schedule(function() vim.cmd('qall') end)
  return 'Saved and closed'
end

-- Keeps the Panels tab's file name and unsaved marker current (tmux/pi-tabs.conf), in the row of the Pi
-- that owns this pane now: a restarted Pi may have adopted it.
if vim.env.PI_TABS and vim.env.PI_PANELS_OWNER and vim.env.TMUX_PANE then
  vim.api.nvim_create_autocmd({ 'BufModifiedSet', 'BufEnter', 'BufWritePost', 'BufDelete' }, {
    callback = function()
      vim.fn.jobstart({ 'node', '--no-warnings', vim.env.PI_TABS, 'refresh-pane', vim.env.TMUX_PANE })
    end,
  })
end
