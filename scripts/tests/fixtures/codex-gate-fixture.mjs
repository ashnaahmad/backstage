// Shared fixture for the Codex stop gate tests: a temporary gate home and coordination record, a synthetic Pi
// transcript for the delegate, and a stub ccmux daemon (GET /sessions) on a free port. Nothing touches tmux, the
// live ccmux daemon or live gate state.
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
export const root = fileURLToPath(new URL('../../../', import.meta.url));
export const gateScript = join(root, 'scripts/codex-stop-gate.mjs');
export const recordScript = join(root, 'scripts/coordination-record.mjs');

/** A Pi transcript in Pi's serialisation order; returns helpers that append entries. */
export function piTranscript(dir, name, { sessionId = `pi-${name}` } = {}) {
  const path = join(dir, `${name}.jsonl`);
  let n = 0;
  let leaf = null;
  const at = () => new Date().toISOString();
  appendFileSync(path, `${JSON.stringify({ type: 'session', version: 3, id: sessionId, timestamp: at(), cwd: dir })}\n`);
  const entry = (message, timestamp = at()) => {
    const e = { type: 'message', id: `${name}-${++n}`, parentId: leaf, timestamp, message };
    appendFileSync(path, `${JSON.stringify(e)}\n`);
    leaf = e.id;
  };
  return {
    path, sessionId,
    /** Append a user message, optionally dated (ISO) in the past. */
    user: (text, when) => entry({ role: 'user', content: [{ type: 'text', text }], timestamp: when ? Date.parse(when) : Date.now() }, when),
    assistant: (text, stopReason = 'stop', when) => entry({ role: 'assistant', content: [{ type: 'text', text }], stopReason,
      timestamp: when ? Date.parse(when) : Date.now() }, when),
  };
}

export async function startFixture({ prefix = 'codex-gate-' } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const sessions = new Map();
  let delay = null;
  const daemon = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/sessions') { res.writeHead(404).end(); return; }
    if (delay) await delay(req, res);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessions: [...sessions.values()] }));
  });
  await new Promise(resolve => daemon.listen(0, '127.0.0.1', resolve));
  const record = join(dir, 'record.json');
  const env = {
    ...process.env,
    CCMUX_PORT: String(daemon.address().port),
    CODEX_STOP_GATE_HOME: join(dir, 'gate'),
    COORDINATION_RECORD: record,
    COORDINATION_ACTOR: 'test-orchestrator',
    COORDINATION_LOCK_TIMEOUT_MS: '2000',
  };
  delete env.CODEX_THREAD_ID;
  delete env.TMUX;
  delete env.TMUX_PANE;
  const fixture = {
    dir, env, record,
    /** Register a delegate transcript with the stub daemon under a status (working, idle, ...). */
    delegate(t, status) {
      sessions.set(t.sessionId, { id: `ccmux-${t.sessionId}`, agentType: 'pi', tmuxPane: '%9', tmuxTarget: 't:1.1',
        nativeSessionId: t.sessionId, logPath: t.path, status, statusChangedAt: new Date().toISOString(), previousStatus: null });
    },
    /** Remove a delegate from the stub daemon, so it can no longer be observed. */
    forget(t) { sessions.delete(t.sessionId); },
    setDelay(fn) { delay = fn; },
    async recordCli(...args) { return (await run('node', [recordScript, ...args], { env })).stdout.trim(); },
    async gate(session, ...args) { return (await run('node', [gateScript, ...args, '--session', session], { env })).stdout.trim(); },
    async hook(event) {
      return new Promise((resolve, reject) => {
        const child = execFile('node', [gateScript, 'hook'], { env }, (error, stdout) => (error ? reject(error) : resolve(JSON.parse(stdout))));
        child.stdin.end(JSON.stringify(event));
      });
    },
    async close() {
      await new Promise(resolve => daemon.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    },
  };
  await fixture.recordCli('init');
  return fixture;
}
