// A minimal client for `codex app-server` (JSON-RPC, one JSON object per line on stdio), for native lifecycle tests
// in a disposable CODEX_HOME. It never connects to a running app-server daemon or the user's Codex home.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

export async function startAppServer(bin, { home, cwd, env }) {
  const child = spawn(bin, ['app-server'], { cwd, env: { ...env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const notifications = [];
  const listeners = new Set();
  let buffer = '';
  let id = 0;
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      } else if (message.method) {
        const entry = { at: Date.now(), ...message };
        notifications.push(entry);
        for (const listener of listeners) listener(entry);
      }
    }
  });
  const call = (method, params) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, message => (message.error ? reject(new Error(`${method}: ${JSON.stringify(message.error)}`)) : resolve(message.result)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  /** Resolve with the first notification (past or future) matching the predicate, or reject after timeoutMs. */
  const waitFor = (predicate, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    const found = notifications.find(predicate);
    if (found) { resolve(found); return; }
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('timed out waiting for a notification')); }, timeoutMs);
    const listener = entry => { if (predicate(entry)) { clearTimeout(timer); listeners.delete(listener); resolve(entry); } };
    listeners.add(listener);
  });
  await call('initialize', { clientInfo: { name: 'codex-stop-gate-e2e', version: '0' }, capabilities: null });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
  return {
    call, waitFor, notifications,
    stderr: () => stderr,
    /** Stop the server: SIGTERM, then SIGKILL if it has not exited within graceMs. */
    async close(graceMs = 5000) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
      await exited;
      clearTimeout(timer);
    },
  };
}

/**
 * Trust the hooks whose command contains `marker` in a disposable CODEX_HOME, the way /hooks records trust
 * (hooks.state.<key>.trusted_hash in that home's config.toml). Returns the trusted hook metadata.
 */
export async function trustHooks(bin, { home, cwd, env, marker }) {
  const server = await startAppServer(bin, { home, cwd, env });
  try {
    const listed = await server.call('hooks/list', { cwds: [cwd] });
    const hooks = listed.data.flatMap(entry => entry.hooks).filter(h => h.handlerType === 'command' && h.command.includes(marker));
    const toml = hooks.map(h => `\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash = ${JSON.stringify(h.currentHash)}\n`).join('');
    appendFileSync(join(home, 'config.toml'), toml);
    return hooks;
  } finally {
    await server.close();
  }
}
