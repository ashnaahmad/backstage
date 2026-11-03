import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn } from 'node:child_process';

/**
 * A wait that ends as soon as the user queues a message. Pi delivers queued messages only between
 * tool calls, so an orchestrator sleeping in one long bash call (`sleep 840; poll`, a watch loop over
 * `ccmux show`) kept the user waiting until it finished. This tool checks the queue several times a
 * second and returns, so the message is read at once.
 */
const TICK_MS = 250;
const OUTPUT_LIMIT = 4000;

// One run of the check command; ends early when `stop()` becomes true.
function check(command: string, cwd: string, timeoutMs: number, stop: () => boolean) {
  return new Promise<{ code: number | null; output: string; stopped: boolean }>(done => {
    const child = spawn('sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', stopped = false;
    const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_LIMIT); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const kill = () => { try { process.kill(-child.pid!, 'SIGTERM'); } catch {} };
    const started = Date.now();
    const timer = setInterval(() => {
      if (stop()) { stopped = true; kill(); }
      else if (Date.now() - started > timeoutMs) { output += `\n[check timed out after ${Math.round(timeoutMs / 1000)}s]`; kill(); }
    }, TICK_MS);
    child.on('close', code => { clearInterval(timer); done({ code, output: output.trim(), stopped }); });
    child.on('error', error => { clearInterval(timer); done({ code: null, output: String(error), stopped }); });
  });
}

export default function wait(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'wait',
    label: 'Wait',
    description: 'Wait for another agent, a process or a review, ending as soon as the user sends a message. ' +
      'Use this instead of sleep or polling loops in bash: queued user messages are only delivered between tool calls, so a long bash wait keeps the user waiting. ' +
      'Without command, waits the given seconds. With command, runs it every `every` seconds (default 15) and stops when it exits 0, returning its output. ' +
      'Returns why it stopped: condition met, time up, or a user message arrived (read it before waiting again).',
    parameters: Type.Object({
      seconds: Type.Number({ minimum: 1, maximum: 7200, description: 'Longest time to wait, in seconds.' }),
      command: Type.Optional(Type.String({ description: 'Shell command checked repeatedly; the wait ends when it exits 0. E.g. a ccmux show/last check or a test for a file or process.' })),
      every: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: 'Seconds between checks (default 15).' })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const started = Date.now(), deadline = started + params.seconds * 1000;
      const every = (params.every ?? 15) * 1000;
      const queued = () => ctx.hasPendingMessages();
      const stop = () => queued() || Boolean(signal?.aborted);
      const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`;
      const reply = (text: string, details: Record<string, unknown>) =>
        ({ content: [{ type: 'text' as const, text }], details: { ...details, elapsedMs: Date.now() - started } });
      let last: { code: number | null; output: string } | undefined;
      while (true) {
        if (params.command) {
          const run = await check(params.command, ctx.cwd, Math.max(every, 60_000), stop);
          if (!run.stopped) {
            last = run;
            if (run.code === 0) return reply(`Condition met after ${elapsed()}.${run.output ? `\n${run.output}` : ''}`, { reason: 'condition', code: 0 });
          }
        }
        const next = Math.min(deadline, Date.now() + (params.command ? every : deadline - Date.now()));
        while (Date.now() < next && !stop()) await new Promise(resolve => setTimeout(resolve, TICK_MS));
        if (signal?.aborted) return reply(`Wait cancelled after ${elapsed()}.`, { reason: 'aborted' });
        if (queued()) return reply(`Stopped after ${elapsed()}: the user sent a message. Read and answer it before waiting again.`, { reason: 'message' });
        if (Date.now() >= deadline) {
          const tail = last ? `\nLast check (exit ${last.code}):${last.output ? `\n${last.output}` : ' no output'}` : '';
          return reply(`Waited ${elapsed()}; ${params.command ? 'the condition was not met' : 'time is up'}.${tail}`, { reason: 'timeout', code: last?.code });
        }
      }
    },
  });
}
