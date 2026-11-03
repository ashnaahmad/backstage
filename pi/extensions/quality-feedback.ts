import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { snapshot, feedback, loadPolicy } from '../../scripts/lib/quality-feedback.ts';

/** Advisory diagnostics in tool results; never edits or blocks a tool. */
export default function qualityFeedback(pi: ExtensionAPI) {
  const pending = new Map();
  const reported = new Set<string>();
  pi.on('before_agent_start', async () => reported.clear());
  pi.on('tool_call', async (event, ctx) => {
    try {
      if (!loadPolicy(ctx.cwd).standingDocuments?.length) return;
      const before = snapshot(event, ctx.cwd);
      if (before) pending.set(event.toolCallId, before);
    } catch (error) {
      pending.set(event.toolCallId, { error: String(error) });
    }
  });
  pi.on('tool_result', async (event) => {
    const before = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!before) return;
    let text;
    try {
      if (before.error) throw new Error(before.error);
      const rows = feedback(before, loadPolicy(before.cwd)).filter(row => !reported.has(row));
      rows.forEach(row => reported.add(row));
      if (!rows.length) return;
      text = 'Quality feedback (advisory; newly observed workspace findings):\n' + rows.slice(0, 10).join('\n') +
        (rows.length > 10 ? `\n${rows.length - 10} more findings; inspect the changed files.` : '') +
        '\nAssess each finding. A "tense" finding is a hint, not a verdict: keep the sentence when it states current fact, and rewrite it when it narrates what changed. ' +
        'For standing documents, integrate changes into the current account rather than append history. ' +
        'Preserve requested history and dates that convey a meaningful constraint. These checks do not verify behaviour.';
    } catch (error) {
      text = `Quality feedback unavailable: ${String(error)}`;
    }
    return { content: [...event.content, { type: 'text', text }], structuredContent: event.structuredContent };
  });
  pi.on('session_start', async () => pending.clear());
  pi.on('session_shutdown', async () => pending.clear());
}
