import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
// TypeScript, not .mjs: Pi's loader imports .mjs natively, and Node keeps that module across /reload.
import { CHECK_INTERVAL_MS, createIdleExit } from '../../scripts/lib/idle-exit.ts';

/**
 * Closes an interactive Pi session after 48 hours with no prompt, agent work or tool call, so forgotten
 * agent windows stop holding memory. The session is saved as usual and `pi --resume` reopens it; under
 * scripts/tmux-task.sh its window closes too. Unsent text in the editor is lost.
 */
export default function idleExit(pi: ExtensionAPI) {
  const idle = createIdleExit();
  let timer: ReturnType<typeof setInterval> | undefined;
  const touch = () => idle.touch();

  pi.on('session_start', async (_event, ctx) => {
    idle.touch();
    if (ctx.mode !== 'tui' || timer) return;
    timer = setInterval(() => {
      if (!idle.shouldExit(ctx)) return;
      clearInterval(timer);
      ctx.shutdown();
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
  });
  pi.on('input', async () => touch());
  pi.on('agent_start', async () => touch());
  pi.on('agent_end', async () => touch());
  pi.on('tool_call', async () => touch());
  pi.on('ui_prompt_end', async () => touch());
  pi.on('session_shutdown', async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
