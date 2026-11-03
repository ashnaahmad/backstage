import { spawn } from 'node:child_process';

export function reviewModel(provider, override) {
  if (override) return override;
  if (provider === 'openai') return 'claude-bridge/claude-opus-5-5';
  if (provider === 'anthropic' || provider === 'claude-bridge') return 'openai/gpt-6.1-sol';
  throw new Error('Choose a reviewer model explicitly for this provider.');
}

/** Fresh reviewer transport. No parent transcript or readiness gate. */
export async function runReview(options, executable = { command: 'pi', args: [] }) {
  const { cwd, model, bridge, brief, instructions, signal, onProgress } = options;
  const started = performance.now();
  let assistantMessages = 0;
  let usageReports = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const metrics = () => ({
    elapsedMs: Math.round(performance.now() - started), assistantMessages, usageReports,
    tokens: usageReports ? { ...tokens, total: Object.values(tokens).reduce((a, b) => a + b, 0) } : null,
  });
  if (signal?.aborted) throw new Error('Review cancelled.');
  const args = [...executable.args, '--mode', 'json', '--print', '--no-session',
    '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp',
    '--no-prompt-templates', '--tools', 'read,bash,grep,find,ls',
    '--model', model, '--system-prompt', instructions];
  if (model.startsWith('claude-bridge/')) args.push('-e', bridge);

  return new Promise((resolve, reject) => {
    const child = spawn(executable.command, args, {
      cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    let pending = '';
    let stderr = '';
    let answer = '';
    let failure;
    let messageFailure;
    let killTimer;
    const kill = (kind) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(kind);
        else process.kill(-child.pid, kind);
      } catch (error) {
        if (error.code !== 'ESRCH') failure = error.message;
      }
    };
    const cancel = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), 1000);
    };
    const consume = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.type === 'agent_settled' && event.aborted) failure = 'Reviewer aborted.';
        if (event.type !== 'message_end' || event.message?.role !== 'assistant') return;
        const message = event.message;
        assistantMessages++;
        const usage = message.usage;
        // Providers initialise counters to zero before receiving usage. Zero-only
        // frames cannot distinguish an absent report from measured zero.
        if (usage && Object.keys(tokens).every(key => Number.isFinite(usage[key]) && usage[key] >= 0)
          && Object.keys(tokens).some(key => usage[key] > 0)) {
          usageReports++;
          for (const key of Object.keys(tokens)) tokens[key] += usage[key];
        }
        onProgress?.(metrics());
        answer = '';
        messageFailure = undefined;
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          messageFailure = message.errorMessage || `Reviewer ${message.stopReason}.`;
        }
        if (message.stopReason === 'stop') {
          answer = (message.content || []).filter(block => block.type === 'text')
            .map(block => block.text).join('\n');
        }
      } catch {
        failure = 'Reviewer returned invalid event JSON.';
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        consume(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.on('error', error => { failure = error.message; });
    child.stdin.on('error', error => { failure = error.message; });
    child.on('close', code => {
      if (signal?.aborted) kill('SIGKILL');
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', cancel);
      consume(pending);
      onProgress?.(metrics());
      if (signal?.aborted) return reject(new Error('Review cancelled.'));
      if (failure || messageFailure || code !== 0 || !answer.trim()) {
        return reject(new Error(failure || messageFailure || `Reviewer exited ${code}: ${stderr.trim() || 'no final answer'}`));
      }
      resolve({ model, text: answer, metrics: metrics() });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdin.end(brief);
  });
}
