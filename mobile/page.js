// Added to ttyd's page by scripts/mobile-terminal.sh: a bar above the terminal for pasting (the
// terminal itself offers no Paste on iPhone), the Sessions sidebar controls, Focus on one pane, moving
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
  const style = document.createElement('style');
  style.textContent = 'body{display:flex;flex-direction:column}#terminal-container{flex:1;min-height:0;height:auto}';
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
  window.addEventListener('pagehide', () => { field.value = ''; });
})();
