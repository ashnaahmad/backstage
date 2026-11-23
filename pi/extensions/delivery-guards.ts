import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRecordPath, readRecord } from '../../scripts/lib/record-store.mjs';
import { blockingWaitReason, claimCorrection, fetchPr, guardMerge, LANDING_MAP_REMINDER as REMINDER, parseMerge, quietDelegates, relayPostCheck, sameCommit,
  slackPermalink, stallFindings, stallReport } from '../../scripts/lib/delivery-checks.mjs';
import { daemonSessions } from '../../scripts/session-snapshot.mjs';

/**
 * Guards for the orchestrating-delivery loop, active only in a session declared as its coordinator or relay
 * (`/delivery coordinator|relay <record> <actor>`, or DELIVERY_ROLE with COORDINATION_RECORD and COORDINATION_ACTOR).
 *
 * Coordinator:
 * - a model request that answers an incoming message carries a reminder to check whether the landing map should
 *   change, rewriting in place (added per request, not stored);
 * - when the coordination record has changed, by any writer, the next tool result carries the landing map's stalls;
 * - a delegate idle without a report to this session since its latest instruction is announced (ending a `wait`);
 * - `gh pr merge` runs only in one plain form, on a PR that is merge-ready on its current head, bound to that head;
 *   `pr … --stage merge-ready` is refused by the record itself; a reply that calls a mapped PR merge-ready while the
 *   check disagrees is followed by a correction (it cannot be withheld: Pi has already shown it).
 * Coordinator and relay:
 * - a long sleep, a sleep loop or a watch command in bash is blocked in favour of the `wait` tool.
 * Relay (review requests from a coordinator are refused: the relay owns them):
 * - a Slack review request about a mapped PR needs live QA on its published head, goes in the recorded thread only
 *   after a head change, one at a time, and has its permalink recorded with the head that was checked.
 */
const ROLE_ENTRY = 'delivery-role';
const ANNOUNCED_ENTRY = 'delivery-announced';
const CLI = fileURLToPath(new URL('../../scripts/coordination-record.mjs', import.meta.url));
const NODE = /^node(\.exe)?$/.test(basename(process.execPath)) ? process.execPath : 'node';
const SLACK_POST = /^mcp__slack[^_]*__slack_(send|schedule)_message$/;
const IDLE_CHECK_MS = Number(process.env.DELIVERY_IDLE_CHECK_SECONDS ?? 300) * 1000;

type Role = { role: 'coordinator' | 'relay'; record: string; actor: string };
type Checked = { id: string; repo: string; number: number; head: string | null; thread: string | null };

const textOf = (content: unknown) => Array.isArray(content)
  ? content.map(block => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : '')).join('\n')
  : typeof content === 'string' ? content : '';

export default function deliveryGuards(pi: ExtensionAPI) {
  let role: Role | undefined;
  let latest: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let generation = 0;
  let checking = false;
  let announced = new Set<string>();
  let recordStamp: string | undefined;
  const pendingPosts = new Map<string, { checked: Checked[]; channel: string | undefined; thread: string | undefined }>();
  /** Posted requests not yet recorded, by PR (repo#number): no further request until the map records one on that head. */
  const unconfirmed = new Map<string, { id: string; head: string | null; reason: string }>();
  const prKey = (c: { repo: string; number: number }) => `${c.repo}#${c.number}`;
  let lastAssistant: { text: string; at: number } | undefined;
  /** At most one correction per incoming message, so a model that repeats the claim cannot loop the session. */
  let corrected = false;

  const load = async () => readRecord(await canonicalRecordPath(role!.record));
  const stamp = async () => {
    try { const s = await stat(role!.record); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch (error) { return (error as NodeJS.ErrnoException).code ?? '?'; }
  };

  const fromEnv = (): Role | undefined => {
    const r = process.env.DELIVERY_ROLE;
    if ((r === 'coordinator' || r === 'relay') && process.env.COORDINATION_RECORD && process.env.COORDINATION_ACTOR) {
      return { role: r, record: process.env.COORDINATION_RECORD, actor: process.env.COORDINATION_ACTOR };
    }
    return undefined;
  };

  const restore = (ctx: ExtensionContext) => {
    const custom = ctx.sessionManager.getEntries().filter(e => e.type === 'custom') as { customType?: string; data?: unknown }[];
    const saved = custom.filter(e => e.customType === ROLE_ENTRY).at(-1)?.data as Role | { role: 'off' } | undefined;
    role = saved ? (saved.role === 'off' ? undefined : saved as Role) : fromEnv();
    announced = new Set(custom.filter(e => e.customType === ANNOUNCED_ENTRY).map(e => String((e.data as { key?: unknown })?.key)));
  };

  /** How delegates address this session: its ccmux id, pane and Pi session id. */
  const owners = async (ctx: ExtensionContext) => {
    const id = ctx.sessionManager.getSessionId();
    try {
      const mine = (await daemonSessions()).filter((s: { nativeSessionId?: string }) => s.nativeSessionId === id);
      return [id, ...mine.flatMap((s: { id: string; tmuxPane?: string }) => [s.id, s.tmuxPane].filter(Boolean) as string[])];
    } catch { return [id]; }
  };

  /** Delegates idle without a report, announced once per instruction; a user message also ends a running `wait`. */
  const checkQuiet = async () => {
    if (role?.role !== 'coordinator' || checking || !latest) return;
    const started = generation;
    checking = true;
    try {
      const ctx = latest;
      const quiet = (await quietDelegates(await load(), { actor: role.actor, owners: await owners(ctx) })).filter(q => q.state === 'quiet');
      if (started !== generation || role?.role !== 'coordinator') return;
      const fresh = quiet.filter(q => !announced.has(`${q.assignment}:${q.session}:${q.instructionAt}`));
      if (!fresh.length) return;
      for (const q of fresh) {
        const key = `${q.assignment}:${q.session}:${q.instructionAt}`;
        announced.add(key);
        pi.appendEntry(ANNOUNCED_ENTRY, { key });
      }
      const text = `[From delivery-guards, automatic check] ${fresh.length === 1 ? 'A delegate has' : 'Delegates have'} gone quiet:\n`
        + fresh.map(q => `- ${q.assignment}: ${q.detail}`).join('\n')
        + '\nRead its pane or transcript and decide: an unsent report, an interrupted run to resume, or work to reassign.';
      if (ctx.isIdle()) pi.sendUserMessage(text);
      else pi.sendUserMessage(text, { deliverAs: 'steer' });
    } catch (error) {
      if (latest?.hasUI) latest.ui.notify(`delivery-guards: quiet-delegate check failed (${(error as Error).message})`, 'warning');
    } finally {
      checking = false;
    }
  };

  const arm = async () => {
    generation++;
    if (timer) clearInterval(timer);
    timer = role?.role === 'coordinator' ? setInterval(() => { void checkQuiet(); }, IDLE_CHECK_MS) : undefined;
    timer?.unref?.();
    recordStamp = role ? await stamp() : undefined;
  };

  pi.registerCommand('delivery', {
    description: 'Declare this session the delivery coordinator or relay: /delivery coordinator|relay <record> <actor>, or /delivery off',
    handler: async (args, ctx) => {
      const [name, record, actor] = args.trim().split(/\s+/).filter(Boolean);
      if (!name) {
        ctx.ui.notify(role ? `delivery-guards: ${role.role} for ${role.actor} on ${role.record}` : 'delivery-guards: off', 'info');
        return;
      }
      if (name === 'off') {
        pi.appendEntry(ROLE_ENTRY, { role: 'off' });
        role = undefined;
        await arm();
        ctx.ui.notify('delivery-guards: off', 'info');
        return;
      }
      if ((name !== 'coordinator' && name !== 'relay') || !record || !actor) {
        ctx.ui.notify('usage: /delivery coordinator|relay <record> <actor>, or /delivery off', 'warning');
        return;
      }
      const path = await canonicalRecordPath(record);
      await readRecord(path);
      role = { role: name, record: path, actor };
      pi.appendEntry(ROLE_ENTRY, role);
      await arm();
      ctx.ui.notify(`delivery-guards: ${name} for ${actor} on ${path}`, 'info');
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    latest = ctx;
    restore(ctx);
    await arm();
  });

  pi.on('session_shutdown', async () => {
    generation++;
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  // A request that answers an incoming message (nothing but non-model messages after the latest user message) gets
  // the reminder right after that message. It is not stored, so it neither accumulates nor takes the delivery slot of
  // a steered message; tool-only continuations of the same message do not repeat it.
  pi.on('context', async (event, ctx) => {
    latest = ctx;
    if (role?.role !== 'coordinator') return undefined;
    const messages = event.messages as { role: string }[];
    const index = messages.findLastIndex(m => m.role === 'user');
    if (index < 0 || messages.slice(index + 1).some(m => m.role === 'assistant' || m.role === 'toolResult')) return undefined;
    const reminder = { role: 'user', content: [{ type: 'text', text: REMINDER }], timestamp: Date.now() };
    return { messages: [...messages.slice(0, index + 1), reminder, ...messages.slice(index + 1)] as never };
  });

  pi.on('tool_call', async (event, ctx) => {
    latest = ctx;
    if (!role) return;
    // Coordinator and relay wait on others; a long shell wait would hold back the messages they wait for.
    if (event.toolName === 'bash' && typeof event.input.command === 'string') {
      const reason = blockingWaitReason(event.input.command);
      if (reason) {
        return { block: true, reason: `Blocked: this command waits in one long shell call (${reason}). Messages from the user and other sessions `
          + 'arrive only between tool calls, so it would hold them back. Use the `wait` tool instead: `seconds` for the longest '
          + 'wait, and `command` with `every` to check a condition (for example `gh pr checks <n>` or `ccmux show --json`).' };
      }
    }
    if (event.toolName === 'bash' && typeof event.input.command === 'string' && role.role === 'coordinator' && parseMerge(event.input.command)) {
      let decision;
      try { decision = await guardMerge(await load(), event.input.command); } catch (error) {
        return { block: true, reason: `Blocked by the merge-readiness guard: the coordination record could not be read (${(error as Error).message}).` };
      }
      if (!decision) return;
      if ('block' in decision) return { block: true, reason: decision.block };
      event.input.command = decision.command;
      return;
    }
    if (SLACK_POST.test(event.toolName)) {
      for (const [key, hold] of unconfirmed) {
        try {
          const a = (await load()).assignments[hold.id];
          if (!a?.pr || prKey(a.pr) !== key) unconfirmed.delete(key);
          else if (a.pr.reviewRequest && hold.head && sameCommit(a.pr.reviewRequest.head, hold.head)) unconfirmed.delete(key);
        } catch { /* kept */ }
      }
      const input = event.input as { message?: string; channel_id?: string; thread_ts?: string };
      let record;
      try { record = await load(); } catch (error) {
        return { block: true, reason: `Blocked by the relay guard: the coordination record could not be read (${(error as Error).message}).` };
      }
      const check = relayPostCheck(record, { message: input.message ?? '', channel: input.channel_id, threadTs: input.thread_ts });
      if (!check.checked.length && !check.problems.length) return;
      if (role.role !== 'relay') return { block: true, reason: 'Blocked by the relay guard: this is a review request, and the relay session owns review requests. Hand it to the relay.' };
      const problems = [...check.problems];
      for (const c of check.checked) {
        const busy = [...pendingPosts.values()].some(p => p.checked.some(x => x.id === c.id)) ? 'a request for it is already being posted' : unconfirmed.get(prKey(c))?.reason;
        if (busy) { problems.push(`${c.repo}#${c.number} (${c.id}): ${busy}`); continue; }
        if (!c.head || check.problems.length) continue;
        try {
          const published = (await fetchPr(c.repo, c.number)).headRefOid;
          if (!sameCommit(published, c.head)) problems.push(`${c.repo}#${c.number} (${c.id}): GitHub's head is ${published.slice(0, 12)}, but the landing map and its QA are on ${c.head.slice(0, 12)}`);
        } catch (error) {
          problems.push(`${c.repo}#${c.number} (${c.id}): its published head could not be checked (${(error as Error).message})`);
        }
      }
      if (problems.length) return { block: true, reason: `Blocked by the relay guard:\n${problems.map(p => `- ${p}`).join('\n')}` };
      pendingPosts.set(event.toolCallId, { checked: check.checked, channel: input.channel_id, thread: input.thread_ts });
    }
  });

  /** Record the request with the head that was checked before posting, whatever the map says now. */
  const recordRequest = async (checked: Checked, permalink: string, thread: string) => {
    const record = await load();
    const a = record.assignments[checked.id];
    if (!a?.pr || a.pr.repo !== checked.repo || a.pr.number !== checked.number) return `not recorded for ${checked.id}: its PR changed after the post was checked; record it by hand`;
    const run = await pi.exec(NODE, [CLI, 'pr', checked.id, '--review-request', permalink, '--thread', thread, '--request-head', checked.head!,
      '--expect-rev', String(a.rev), '--record', role!.record, '--as', role!.actor], { timeout: 15_000 });
    const note = a.pr.head !== checked.head ? ` (the map's head moved to ${String(a.pr.head).slice(0, 12)} meanwhile; the request is recorded on the checked head ${checked.head!.slice(0, 12)})` : '';
    return run.code === 0 ? `recorded the review request for ${checked.id}${note} (${run.stdout.trim()})` : `could not record the review request for ${checked.id}: ${(run.stderr || run.stdout).trim()}`;
  };

  const stallText = async (ctx: ExtensionContext) => {
    try {
      const record = await load();
      const findings = stallFindings(record, { actor: role!.actor, quiet: await quietDelegates(record, { actor: role!.actor, owners: await owners(ctx) }) });
      return stallReport(findings);
    } catch (error) {
      return `Landing map stall check could not run: ${(error as Error).message}`;
    }
  };

  pi.on('tool_result', async (event, ctx) => {
    latest = ctx;
    if (!role) return;
    const notes: string[] = [];
    const post = pendingPosts.get(event.toolCallId);
    if (post) {
      pendingPosts.delete(event.toolCallId);
      if (!event.isError) {
        const link = slackPermalink(textOf(event.content));
        // Every successful post holds further requests for its PRs until the map records this one on the checked head.
        for (const c of post.checked) unconfirmed.set(prKey(c), { id: c.id, head: c.head, reason: `its last request (head ${String(c.head).slice(0, 12)}) is not recorded yet; read it back and record it (pr --review-request … --request-head ${c.head}) before posting again` });
        if (!link || (post.channel && link.channel !== post.channel)) {
          notes.push(`Relay guard: no permalink for this post found in the result, so the review request for ${post.checked.map(c => c.id).join(', ')} is not recorded and further requests for it are held. Read the post back and record it with \`coordination-record.mjs pr <id> --review-request <permalink> --thread <ts> --request-head <sha>\`.`);
        } else {
          for (const c of post.checked) {
            const outcome = await recordRequest(c, link.permalink, post.thread ?? link.threadTs ?? link.ts);
            if (outcome.startsWith('recorded')) unconfirmed.delete(prKey(c));
            notes.push(`Relay guard: ${outcome}${outcome.startsWith('recorded') ? '' : '; further requests for it are held until it is recorded'}`);
          }
        }
      }
    }
    // The landing map changed, by this session or any other writer: report its stalls once per change.
    if (role.role === 'coordinator') {
      const now = await stamp();
      if (now !== recordStamp) {
        recordStamp = now;
        const text = await stallText(ctx);
        if (text) notes.push(text);
      }
    }
    if (!notes.length) return;
    return { content: [...event.content, { type: 'text', text: notes.join('\n') }] };
  });

  pi.on('before_agent_start', async event => {
    if (event.messageType === 'user') corrected = false;
    return undefined;
  });

  pi.on('agent_end', async event => {
    const assistant = (event.messages as { role: string; content: unknown; timestamp?: number }[]).filter(m => m.role === 'assistant').at(-1);
    lastAssistant = assistant ? { text: textOf(assistant.content), at: assistant.timestamp ?? Date.now() } : undefined;
  });

  // A reply that calls a mapped PR merge-ready while the check disagrees is followed by a correction, once per
  // incoming message.
  pi.on('agent_before_settle', async (event, ctx) => {
    latest = ctx;
    if (role?.role !== 'coordinator' || !lastAssistant || corrected) return;
    let correction;
    try { correction = await claimCorrection(await load(), lastAssistant.text); } catch { return; }
    if (!correction) return;
    corrected = true;
    return {
      entries: [...event.entries, { type: 'custom_message', customType: 'delivery-merge-claim', display: true,
        content: correction }],
      continue: true,
    };
  });
}
