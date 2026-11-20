// Added to ttyd's page by scripts/mobile-terminal.sh: a bar above the terminal for pasting (the
// terminal itself offers no Paste on iPhone), Text for reading and copying the active pane's text (the
// terminal offers no selection on iPhone), the Sessions sidebar controls, Focus on one pane, moving
// between the sidebar, Pi and preview panes, and
// Edit, Esc and Save for the Markdown editor pane (the iPhone keyboard has no Esc).
(() => {
  const bar = document.createElement('div');
  bar.style.cssText = 'order:-1;flex:none;background:#20252b;padding:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;color:white;font:16px sans-serif';
  const button = (label, name) => {
    const element = document.createElement('button');
    element.textContent = label;
    element.setAttribute('aria-label', name);
    element.style.cssText = 'font-size:16px;padding:8px 12px';
    return element;
  };
  // Masked by default, for credentials such as a pi-secrets prompt; Show reveals ordinary text.
  const field = document.createElement('input');
  field.type = 'password';
  field.placeholder = 'Hold here to paste';
  field.autocomplete = 'off';
  field.autocapitalize = 'off';
  field.spellcheck = false;
  field.setAttribute('autocorrect', 'off');
  field.setAttribute('aria-label', 'Text to paste into the active terminal pane');
  field.style.cssText = 'font-size:16px;min-width:150px;flex:1;padding:8px';
  const show = button('Show', 'Show or mask the text');
  show.onclick = () => {
    field.type = field.type === 'password' ? 'text' : 'password';
    show.textContent = field.type === 'password' ? 'Show' : 'Mask';
  };
  const paste = button('Paste', 'Paste into the active terminal pane');
  const note = document.createElement('span');
  note.style.cssText = 'font-size:13px;flex:1 1 150px';
  note.textContent = 'Pastes into the active pane below, without Return.';
  // Key sequences bound in tmux/mobile.conf, acting on the window this page shows; the editor's
  // act only when its pane is the active one.
  const controls = document.createElement('span');
  controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
  const text = button('Text', 'Show the active pane\'s text to read and copy');
  text.onmousedown = event => event.preventDefault();
  controls.append(text);
  const interrupt = button('Ctrl+C', 'Interrupt the command in the active terminal pane');
  interrupt.onmousedown = event => event.preventDefault();
  interrupt.onclick = () => {
    const term = window.term;
    if (!term) { note.textContent = 'Wait for the terminal to connect.'; return; }
    term.input('\x03');
    note.textContent = 'Sent Ctrl+C to the active pane.';
  };
  controls.append(interrupt);
  for (const [label, name, key] of [['Sidebar', 'Show or hide the sessions sidebar', '9001'],
    ['\u2212', 'Narrower sidebar', '9002'], ['+', 'Wider sidebar', '9003'],
    ['Focus', 'Show only the active pane, or every pane again', '9007'],
    ['Sessions', 'Go to the sessions sidebar pane', '9008'], ['Agent', 'Go to the Pi pane', '9009'],
    ['Preview', 'Go to the Markdown editor or diff pane', '9010'],
    ['Edit', 'Start typing in the Markdown editor', '9004'], ['Esc', 'Stop typing in the Markdown editor', '9005'],
    ['Save', 'Save the Markdown document', '9006']]) {
    const control = button(label, name);
    // Keeps the terminal's keyboard focus, so a button press does not close the on-screen keyboard;
    // Edit also opens it.
    control.onmousedown = event => event.preventDefault();
    control.onclick = () => {
      window.term?.input(`\x1b[${key}~`);
      if (key === '9004') window.term?.focus();
    };
    controls.append(control);
  }
  bar.append(field, show, paste, controls, note);
  document.body.append(bar);
  // The bar sits above the terminal, which fills the rest of the page and refits when the bar's
  // height changes (a longer note wraps), so the bottom rows stay on screen.
  // ttyd centres the terminal with auto margins, which in this column stop it stretching: it kept its
  // first width, wider than a phone, and fitting it measured that width again, so the right of every
  // row was cut off. Full width lets it fit the screen.
  const style = document.createElement('style');
  style.textContent = 'body{display:flex;flex-direction:column}#terminal-container{flex:1;min-height:0;height:auto;width:100%;margin:0}';
  document.head.append(style);
  new ResizeObserver(() => window.term?.fit()).observe(bar);
  paste.onclick = () => {
    const term = window.term;
    if (!term) { note.textContent = 'Wait for the terminal to connect.'; return; }
    const value = field.value;
    if (!value) { note.textContent = 'Paste into the field first.'; return; }
    // A line break could reach the program as Return.
    if (/[\x00-\x1f\x7f]/.test(value)) { note.textContent = 'Paste one line, without control characters.'; return; }
    term.paste(value);
    field.value = '';
    note.textContent = `Pasted ${value.length} characters. Check them, then press Return in the terminal.`;
    term.focus();
  };

  // Text: the terminal draws its rows itself, so iPhone cannot select them, and programs such as Pi break
  // a long link across rows. tmux sends the active pane's text (tmux/mobile.conf) to this page only, as a
  // clipboard sequence (OSC 52) ending in a marker line. It is accepted only just after a Text press and
  // with that marker, so another program's clipboard write is left alone; the sheet shows the text as
  // ordinary text to scroll both ways, select and copy.
  const sheet = document.createElement('div');
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Text of the active pane');
  sheet.style.cssText = 'position:fixed;inset:0;z-index:10;display:none;flex-direction:column;background:#111;color:#eee;font:16px sans-serif';
  const sheetBar = document.createElement('div');
  sheetBar.style.cssText = 'flex:none;background:#20252b;padding:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center';
  const copy = button('Copy', 'Copy the selected text');
  const copyJoined = button('Copy as one line', 'Copy the selected text without its line breaks and the spaces around them, for a link split across rows');
  const close = button('Close', 'Close the text and return to the terminal');
  const sheetNote = document.createElement('span');
  sheetNote.style.cssText = 'font-size:13px;flex:1 1 100%';
  const content = document.createElement('pre');
  content.style.cssText = 'flex:1;min-height:0;margin:0;padding:8px;overflow:auto;white-space:pre;font:14px monospace;user-select:text;-webkit-user-select:text;-webkit-touch-callout:default';
  sheetBar.append(copy, copyJoined, close, sheetNote);
  sheet.append(sheetBar, content);
  document.body.append(sheet);
  let selected = '';
  const hideSheet = () => {
    sheet.style.display = 'none';
    content.textContent = '';
    selected = '';
    window.getSelection()?.removeAllRanges();
  };
  let requested = 0;
  const marker = '\n--pi-mobile-text--';
  text.onclick = () => {
    if (!window.term) { note.textContent = 'Wait for the terminal to connect.'; return; }
    const at = requested = Date.now();
    window.term.input('\x1b[9011~');
    setTimeout(() => { if (requested === at) note.textContent = 'No text arrived from the terminal; press Text again.'; }, 5000);
  };
  const install = () => {
    if (!window.term?.parser) { setTimeout(install, 200); return; }
    window.term.parser.registerOscHandler(52, data => {
      if (!requested || Date.now() - requested > 5000) return false;
      let value;
      try {
        value = new TextDecoder().decode(Uint8Array.from(atob(data.slice(data.indexOf(';') + 1)), c => c.charCodeAt(0)));
      } catch { return false; }
      if (!value.endsWith(marker)) return false;
      requested = 0;
      content.textContent = value.slice(0, -marker.length).replace(/\n*$/, '\n');
      sheetNote.textContent = 'Hold on the text to select it; drag sideways to see long rows.';
      sheet.style.display = 'flex';
      window.term.blur();
      content.scrollTop = content.scrollHeight;
      content.scrollLeft = 0;
      return true;
    });
  };
  install();
  // The current selection inside the text, if any.
  const selection = () => {
    const current = window.getSelection();
    return current && current.rangeCount && content.contains(current.anchorNode) ? current.toString() : '';
  };
  const copyText = async value => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Older iPhone browsers: copy from a temporary field instead.
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
      document.body.append(area);
      area.select();
      area.setSelectionRange(0, value.length);
      const done = document.execCommand('copy');
      area.remove();
      return done;
    }
  };
  for (const [control, join] of [[copy, false], [copyJoined, true]]) {
    // Read as the press starts, for this press only: on iPhone the tap can clear the selection by the
    // time of the click.
    control.onpointerdown = () => { selected = selection(); };
    control.onmousedown = event => event.preventDefault();
    control.onclick = async () => {
      const value = selection() || selected;
      selected = '';
      if (!value) { sheetNote.textContent = 'Select some text first.'; return; }
      const result = join ? value.replace(/\s*\n\s*/g, '').trim() : value;
      sheetNote.textContent = await copyText(result)
        ? `Copied ${result.length} characters${join ? ' as one line' : ''}.`
        : 'Copying failed: use Copy in the menu over the selection.';
    };
  }
  close.onclick = hideSheet;
  window.addEventListener('pagehide', () => { field.value = ''; hideSheet(); });
})();
