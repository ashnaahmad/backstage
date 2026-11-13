// Native clipboard for Hunk under tmux: tmux runs this with a Hunk pane's output on stdin (pipe-pane -O,
// attachHunkClipboard in scripts/lib/diff-pane.ts). Hunk copies a selection with OSC 52 only, and under tmux
// it wraps that in DCS passthrough, which tmux neither keeps nor turns into a clipboard write; the Mac
// clipboard needs pbcopy. This reads the copies (plain or wrapped OSC 52) and hands their text to pbcopy
// on stdin, never through a shell; everything else Hunk writes is discarded. Arguments: the pbcopy to run
// (resolved by Pi), then tmux socket and pane, for reporting a failure there (never the copied text). Exits
// when the pane closes (end of input), once a running copy has finished or timed out.
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ESC = 0x1b, BEL = 0x07;
export const MAX_SEQUENCE = 8 * 1024 * 1024;   // bytes of one OSC or DCS body; longer ones are skipped whole
// Padded base64, checked in linear time (a regex with repeated groups overflows the stack on long input).
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The text of an OSC 52 body ("52;<targets>;<base64>") to copy, or undefined: queries, clears and malformed data copy nothing. */
export function osc52Text(body) {
  const text = body.toString('latin1');
  const match = /^52;[a-z0-9]*;/.exec(text);
  const data = match && text.slice(match[0].length);
  if (!data || data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  return Buffer.from(data, 'base64');
}

/**
 * A streaming parser of terminal output: calls `onCopy(bytes)` for each OSC 52 copy, in order, whether plain or
 * inside tmux DCS passthrough (`ESC P tmux; … ESC \`, its ESCs doubled). Sequences may be split across chunks;
 * one longer than MAX_SEQUENCE is dropped whole (`onError`), and its remainder is skipped, not misread.
 */
export function createParser(onCopy, onError = () => {}, max = MAX_SEQUENCE) {
  // The current sequence's body, in a buffer that grows by doubling up to `max` bytes.
  let state = 'ground', body = Buffer.alloc(256), size = 0, overflow = false;
  const begin = next => { state = next; size = 0; overflow = false; if (body.length > 65536) body = Buffer.alloc(256); };
  const add = byte => {
    if (overflow) return;
    if (size >= max) { overflow = true; body = Buffer.alloc(256); onError('a clipboard sequence was too long and was ignored'); return; }
    if (size === body.length) { const grown = Buffer.alloc(Math.min(max, body.length * 2)); body.copy(grown); body = grown; }
    body[size++] = byte;
  };
  const content = () => Buffer.from(body.subarray(0, size));
  const finishOsc = () => {
    if (!overflow) { const text = osc52Text(content()); if (text) onCopy(text); }
    state = 'ground';
  };
  const finishDcs = () => {
    if (!overflow) {
      const data = content();
      // tmux passthrough: the inner sequence with its ESCs undoubled (done while reading), parsed afresh.
      if (data.subarray(0, 5).toString('latin1') === 'tmux;') {
        const inner = createParser(onCopy, onError, max);
        inner.write(data.subarray(5));
      }
    }
    state = 'ground';
  };
  return {
    write(chunk) {
      for (const byte of chunk) {
        switch (state) {
          case 'ground': if (byte === ESC) state = 'escape'; break;
          case 'escape':
            if (byte === 0x5d) begin('osc');          // ]
            else if (byte === 0x50) begin('dcs');     // P
            else state = byte === ESC ? 'escape' : 'ground';
            break;
          case 'osc':
            if (byte === BEL) finishOsc();
            else if (byte === ESC) state = 'osc-escape';
            else add(byte);
            break;
          case 'osc-escape':
            if (byte === 0x5c) finishOsc();          // ESC \ ends it
            else if (byte === 0x5d) begin('osc');    // a new OSC: the old one was cut off
            else if (byte === 0x50) begin('dcs');
            else state = 'ground';
            break;
          case 'dcs':
            if (byte === ESC) state = 'dcs-escape'; else add(byte);
            break;
          case 'dcs-escape':
            if (byte === 0x5c) finishDcs();          // ESC \ ends it
            else if (byte === ESC) { add(ESC); state = 'dcs'; }   // a doubled ESC is one ESC inside
            else state = 'ground';                   // malformed: drop it
            break;
        }
      }
    },
  };
}

/**
 * Runs `copy(bytes)` (a Promise) for each copy in order, one at a time. While one runs, only the newest
 * waiting copy is kept: the clipboard ends with the last one, and at most two copies are held in memory.
 */
export function createQueue(copy, onError) {
  let running = false, pending;
  const next = async () => {
    if (running || !pending) return;
    running = true;
    const bytes = pending; pending = undefined;
    try { await copy(bytes); } catch (error) { onError(String(error?.message ?? error)); }
    running = false;
    next();
  };
  return { push(bytes) { pending = bytes; next(); }, idle: () => !running && !pending };
}

// pbcopy reads UTF-8 only under a UTF-8 locale; LC_ALL would override LC_CTYPE, so it is removed.
export function pbcopyEnv(env = process.env) {
  const { LC_ALL: _, ...rest } = env;
  return { ...rest, LC_CTYPE: 'UTF-8' };
}
// One that stalls is killed, so no copy outlives its pane for long.
export const pbcopy = (bytes, command, timeout = 5000) => new Promise((done, failed) => {
  const child = spawn(command, [], { stdio: ['pipe', 'ignore', 'ignore'], env: pbcopyEnv(), timeout, killSignal: 'SIGKILL' });
  child.once('error', error => failed(new Error(`pbcopy could not start (${error.code ?? 'error'})`)));
  child.once('exit', (code, signal) => code === 0 ? done() : failed(new Error(signal ? `pbcopy stopped (${signal}), likely after ${timeout} ms` : `pbcopy exited ${code}`)));
  child.stdin.on('error', () => {});
  child.stdin.end(bytes);
});

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, socket, pane] = process.argv.slice(2);
  // A failure shows briefly on the pane's client, never with the copied text.
  const report = message => {
    process.stderr.write(`hunk-clipboard: ${message}\n`);
    if (socket && pane) execFile('tmux', ['-S', socket, 'display-message', '-t', pane, `Hunk clipboard: ${message}`], () => {});
  };
  const queue = createQueue(bytes => pbcopy(bytes, command), report);
  const parser = createParser(bytes => queue.push(bytes), report);
  process.stdin.on('data', chunk => parser.write(chunk));
  process.stdin.on('error', () => {});
}
