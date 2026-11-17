#!/usr/bin/env node
// Read-only snapshot of a Pi session for an orchestrator: ccmux activity, the latest user message on the session's
// persisted conversation path, and whether a finished reply was written after it. `ccmux last` can print an
// older reply while a newer instruction is still unanswered; this reports their order instead.
//
// Usage: session-snapshot.mjs <ccmux-session-id | %pane | pi-session-id> [--since <ISO time>] [--json]
//          [--chars <n>] [--no-text]
//
// Evidence, not certification: a reply after an instruction proves a later finished message, not that it fulfilled
// the instruction; --since bounds an observation window and does not identify which send produced a message.
// Sources: the running ccmux daemon's GET /sessions (never started or replaced from here; CCMUX_PORT as in ccmux)
// and the Pi transcript. Lines are parsed as JSON; only `text` blocks of user and assistant messages are kept, and
// thinking and tool content is never output.
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Same per-line guard as ccmux's transcript reader: longer lines are skipped without parsing. Their envelope
// (type, id, parentId, timestamp, role) is read from the line's first bytes, where Pi serialises it.
export const MAX_LINE_BYTES = 256 * 1024;
const HEAD_BYTES = 1024;
export const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;
export const DEFAULT_REPLY_CHARS = 4000;
const PREVIEW_CHARS = 160;
const LEAF_BASIS = 'newest persisted entry, followed through parentId (where Pi resumes); /tree navigation not yet '
  + 'followed by a new entry is not visible';
/** What every verdict is about. The live leaf and the source of ccmux's status are not observable here. */
const VERDICT_SCOPE = 'persisted transcript path and ccmux-reported activity; the current /tree position and the '
  + 'origin of the ccmux status are not established';
/** parentId of an entry whose parent field is absent or malformed (distinct from null, the root). */
const NO_PARENT = Symbol('no parent');

/** Lines of a file, newest first, as { text } or { oversized: true, head } for a line over maxLineBytes. */
export async function* readLinesBackwards(path, { chunkSize = 64 * 1024, maxLineBytes = MAX_LINE_BYTES,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES, stats = {} } = {}) {
  const handle = await open(path, 'r');
  try {
    let pos = (await handle.stat()).size;
    const stopAt = Math.max(0, pos - maxScanBytes);
    stats.scannedBytes = 0;
    stats.reachedStart = false;
    // Pi appends each entry with its newline in one write, so a file not ending in one has a partial newest entry.
    const last = Buffer.alloc(1);
    stats.endsWithNewline = pos > 0 && (await handle.read(last, 0, 1, pos - 1)).bytesRead === 1 && last[0] === 0x0a;
    let carry = Buffer.alloc(0);
    let oversized = false;
    const finish = () => {
      // When oversized, carry holds the line's leftmost bytes (its head), capped at HEAD_BYTES.
      const out = oversized ? { oversized: true, head: carry.toString('utf8') } : carry.length ? { text: carry.toString('utf8') } : null;
      carry = Buffer.alloc(0);
      oversized = false;
      return out;
    };
    const prepend = bytes => {
      if (oversized) {
        carry = Buffer.concat([bytes, carry]).subarray(0, HEAD_BYTES);
      } else if (bytes.length + carry.length > maxLineBytes) {
        oversized = true;
        carry = Buffer.concat([bytes, carry]).subarray(0, HEAD_BYTES);
      } else {
        carry = Buffer.concat([bytes, carry]);
      }
    };
    while (pos > stopAt) {
      const start = Math.max(stopAt, pos - chunkSize);
      const chunk = Buffer.alloc(pos - start);
      await handle.read(chunk, 0, chunk.length, start);
      stats.scannedBytes += chunk.length;
      pos = start;
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== 0x0a) continue;
        prepend(chunk.subarray(i + 1, end));
        end = i;
        const line = finish();
        if (line) yield line;
      }
      prepend(chunk.subarray(0, end));
    }
    // A partial line at the scan limit is incomplete, so it is only yielded when the walk reached the file start.
    if (pos === 0) {
      stats.reachedStart = true;
      const line = finish();
      if (line) yield line;
    }
  } finally {
    await handle.close();
  }
}

const stringField = (head, name) => head.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];

/** Envelope facts from the first bytes of an oversized line, or null when they are not all there. */
export function envelopeFromHead(head) {
  if (!head.startsWith('{"type":"')) return null;
  const type = stringField(head, 'type');
  const id = stringField(head, 'id');
  const parentMatch = head.match(/"parentId":(null|"((?:[^"\\]|\\.)*)")/);
  if (!type || !id || !parentMatch) return null;
  const role = type === 'message' ? head.match(/"message":\{"role":"(\w+)"/)?.[1] : undefined;
  if (type === 'message' && !role) return null;
  return { type, id, parentId: parentMatch[1] === 'null' ? null : parentMatch[2], timestamp: stringField(head, 'timestamp'), role };
}

// Same reading as ccmux's Pi classifier: only `text` content blocks are conversation text.
function textBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}

/** One transcript entry reduced to what the snapshot uses. Text is kept only for user and assistant messages. */
function reduceEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') return null;
  const parentId = entry.parentId === null ? null : typeof entry.parentId === 'string' ? entry.parentId : NO_PARENT;
  const base = { type: entry.type, id: typeof entry.id === 'string' ? entry.id : undefined, parentId,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : undefined };
  if (entry.type !== 'message') return base;
  const message = entry.message ?? {};
  const role = typeof message.role === 'string' ? message.role : undefined;
  if (role === 'user') return { ...base, role, text: textBlocks(message.content) };
  if (role === 'assistant') {
    return { ...base, role, stopReason: typeof message.stopReason === 'string' ? message.stopReason : undefined,
      text: textBlocks(message.content) };
  }
  return { ...base, role };
}

const clean = text => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
const preview = text => {
  const flat = clean(text).replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat;
};
const tail = (text, chars) => {
  const cleaned = clean(text);
  return cleaned.length > chars ? { text: `… ${cleaned.slice(-chars)}`, truncated: true } : { text: cleaned, truncated: false };
};
const time = value => (value === undefined ? NaN : Date.parse(value));

/** The session header (first line) of a Pi transcript, or null when it is not readable. */
async function readSessionHeader(path) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const entry = JSON.parse(first);
    return entry?.type === 'session' ? { id: entry.id ?? null, at: typeof entry.timestamp === 'string' ? entry.timestamp : null } : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Walk a Pi transcript backwards along the persisted conversation path (leaf = newest entry, then parentId).
 * Without --since it stops once the newest reply and the newest user message are both known (path order is
 * structural); with --since it reads the whole path, because timestamps need not increase along it.
 */
export async function analyzePiTranscript(path, { since, replyChars = DEFAULT_REPLY_CHARS,
  maxScanBytes = DEFAULT_MAX_SCAN_BYTES, maxLineBytes } = {}) {
  const sinceMs = since === undefined ? undefined : time(since);
  const stats = {};
  const notes = [];
  const result = {
    leafEntryId: null, leafAt: null, leafBasis: LEAF_BASIS,
    latestUserMessage: null,
    afterLatestUserMessage: { assistantMessages: 0, last: null, uncertainMessages: 0 },
    latestReply: null,
    userMessagesAfterLatestReply: 0,
    extensionMessagesAfterLatestReply: 0,
    sinceWindow: since === undefined ? undefined : { since, userMessages: [], extensionMessages: [], complete: false },
    offPathMessages: 0,
    sessionHeader: null,
    scan: null,
    pathComplete: false,
    newestLineUnreadable: false,
  };
  const userMessages = []; // user messages on the path, newest first
  const extensionMessages = []; // custom_message entries on the path, newest first
  let want; // id of the next (older) entry on the path; undefined until the leaf is known
  let uncertainSinceReply = false; // an on-path assistant message newer than the reply whose stopReason is unknown
  let brokenAt = null; // why the path cannot be followed further, if it cannot
  let unreadableLines = 0;

  const done = () => sinceMs === undefined && result.latestReply !== null && userMessages.length > 0;

  let newestLine = true;
  for await (const line of readLinesBackwards(path, { maxScanBytes, maxLineBytes, stats })) {
    const isNewest = newestLine;
    newestLine = false;
    let entry;
    if (isNewest && !stats.endsWithNewline) {
      entry = null; // even a readable envelope may belong to an entry Pi has not finished writing
    } else if (line.oversized) {
      entry = envelopeFromHead(line.head);
      if (entry) entry.oversized = true;
    } else {
      try { entry = reduceEntry(JSON.parse(line.text)); } catch { entry = null; }
    }
    if (!entry || (entry.type !== 'session' && entry.id === undefined)) {
      // Unknown id: if it was on the path, the chain cannot continue past it. The newest line can also be one
      // Pi is still appending.
      if (isNewest) {
        result.newestLineUnreadable = true;
        notes.push('the newest transcript line is incomplete or unreadable (Pi may be writing it); the newest entry is missing, so the verdict is unknown');
      } else unreadableLines++;
      continue;
    }
    if (entry.type === 'session') continue;
    if (want === undefined) {
      want = entry.id;
      result.leafEntryId = entry.id;
      result.leafAt = entry.timestamp ?? null;
    }
    if (want === null || entry.id !== want) {
      if (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant')) result.offPathMessages++;
      continue;
    }
    if (entry.parentId === NO_PARENT) {
      brokenAt = `entry ${entry.id} has no valid parentId`;
      want = NO_PARENT;
    } else {
      want = entry.parentId;
    }

    if (entry.type === 'custom_message') {
      extensionMessages.push({ entryId: entry.id, at: entry.timestamp ?? null });
      if (!result.latestReply) result.extensionMessagesAfterLatestReply++;
    } else if (entry.type === 'message' && entry.role === 'user') {
      userMessages.push({ entryId: entry.id, at: entry.timestamp ?? null,
        preview: entry.oversized ? null : preview(entry.text), textAvailable: !entry.oversized });
      if (!result.latestReply) result.userMessagesAfterLatestReply++;
    } else if (entry.type === 'message' && entry.role === 'assistant') {
      const unknownStop = entry.oversized; // stopReason follows the content, beyond the head that was read
      if (userMessages.length === 0) {
        result.afterLatestUserMessage.assistantMessages++;
        if (unknownStop) result.afterLatestUserMessage.uncertainMessages++;
        result.afterLatestUserMessage.last ??= { entryId: entry.id, at: entry.timestamp ?? null,
          stopReason: unknownStop ? 'unknown' : entry.stopReason ?? 'missing' };
      }
      if (!result.latestReply) {
        if (unknownStop) uncertainSinceReply = true;
        else if (entry.stopReason === 'stop') {
          const reply = tail(entry.text, replyChars);
          result.latestReply = { entryId: entry.id, at: entry.timestamp ?? null, order: null,
            text: reply.text, textTruncated: reply.truncated, hasText: entry.text.length > 0 };
        }
      }
    }
    if (want === null) { result.pathComplete = true; break; }
    if (want === NO_PARENT || done()) break;
  }

  result.sessionHeader = await readSessionHeader(path);
  result.scan = { scannedBytes: stats.scannedBytes ?? 0, reachedStart: !!stats.reachedStart };
  if (want === undefined) {
    result.empty = true;
    return { ...result, notes };
  }
  if (!brokenAt && typeof want === 'string' && result.scan.reachedStart) {
    brokenAt = `entry ${want} was not found${unreadableLines ? ' (an unreadable line may have held it)' : ''}`;
  }
  if (brokenAt) notes.push(`the conversation path breaks: ${brokenAt}; older entries were not examined`);
  else if (!result.pathComplete && !done()) {
    notes.push(`scan stopped after ${result.scan.scannedBytes} bytes, before the start of the conversation path`);
  }
  result.pathBroken = !!brokenAt;

  result.latestUserMessage = userMessages[0] ?? null;
  if (result.latestReply) {
    result.latestReply.order = !result.latestUserMessage ? 'no-user-message-observed'
      : result.userMessagesAfterLatestReply > 0 ? 'before-latest-user-message' : 'after-latest-user-message';
  } else if (!result.pathComplete) {
    result.userMessagesAfterLatestReply = null; // unknown: the reply, if any, is beyond what was read
    result.extensionMessagesAfterLatestReply = null;
  }
  if (uncertainSinceReply) {
    notes.push('an assistant message newer than the reported reply was too large to read its stop reason; it may itself be a newer reply');
  }
  if (result.extensionMessagesAfterLatestReply > 0) {
    notes.push(`${result.extensionMessagesAfterLatestReply} extension message(s) were recorded after the latest reply; one may have started a turn that no user message shows`);
  }
  if (result.latestReply && !result.latestReply.hasText) notes.push('the latest finished reply has no text blocks');
  if (result.latestUserMessage && !result.latestUserMessage.at) notes.push('the latest user message has no timestamp');

  if (result.sinceWindow) {
    const window = result.sinceWindow;
    const inWindow = items => items.filter(item => time(item.at) >= sinceMs).map(({ entryId, at }) => ({ entryId, at })).reverse();
    window.userMessages = inWindow(userMessages);
    window.extensionMessages = inWindow(extensionMessages);
    window.undated = [...userMessages, ...extensionMessages].filter(item => Number.isNaN(time(item.at))).length;
    window.complete = result.pathComplete;
    if (!window.complete) notes.push('the --since window may hold more messages than listed: the scan did not reach the start of the path');
    if (window.undated) notes.push(`${window.undated} message(s) without a parseable timestamp cannot be placed relative to --since`);
    if (window.userMessages.length > 1) {
      notes.push(`${window.userMessages.length} user messages were recorded since --since; the window does not say which send produced which`);
    }
    if (time(result.sessionHeader?.at) > sinceMs) {
      notes.push('this transcript file started after --since; an earlier message may be in a previous session file');
    }
  }
  if (result.offPathMessages > 0 && !brokenAt) {
    notes.push(`${result.offPathMessages} message(s) in the scanned part are on another branch and were excluded`);
  }
  return { ...result, notes };
}

/**
 * The single classification: what the persisted transcript path and ccmux's reported status together support,
 * never more. ccmux's Pi status usually comes from its extension (working at agent_start, idle at agent_end) but
 * can come from pane rules; Pi can retry after an error once idle.
 * `reply-observed` means a finished assistant message was written after the latest user message, nothing about
 * whether it fulfilled it.
 */
export function classify(status, analysis) {
  if (analysis.empty || analysis.newestLineUnreadable) return 'unknown';
  const window = analysis.sinceWindow;
  if (window && window.userMessages.length === 0) {
    const certain = window.complete && window.undated === 0 && window.extensionMessages.length === 0;
    return certain ? 'no-user-message-since' : 'unknown';
  }
  const latest = analysis.latestUserMessage;
  if (!latest) return 'unknown';
  // An extension message after the reply may have started a turn no user message records.
  if (analysis.extensionMessagesAfterLatestReply > 0) return 'unknown';
  const after = analysis.afterLatestUserMessage;
  const reply = analysis.latestReply;
  if (reply?.order === 'after-latest-user-message') {
    if (status === 'idle') return 'reply-observed';
    if (status === 'working' || status === 'waiting') return 'reply-observed-still-working';
    return 'unknown';
  }
  if (after.uncertainMessages > 0) return 'unknown';
  if (status === 'working' || status === 'waiting') return 'in-progress';
  if (status !== 'idle') return 'unknown';
  const stop = after.last?.stopReason;
  if (stop === 'aborted') return 'interrupted';
  if (stop === 'error') return 'errored-no-reply';
  if (stop === 'length') return 'ended-without-reply';
  return 'idle-without-reply';
}

export function buildSnapshot(session, analysis, { observedAt = new Date().toISOString(), error } = {}) {
  const snapshot = {
    observedAt,
    session: {
      id: session.id, tmuxPane: session.tmuxPane ?? null, tmuxTarget: session.tmuxTarget ?? null,
      agentType: session.agentType, nativeSessionId: session.nativeSessionId ?? null,
      transcriptPath: session.logPath ?? null,
    },
    activity: { status: session.status ?? null, statusChangedAt: session.statusChangedAt ?? null,
      previousStatus: session.previousStatus ?? null, source: 'ccmux daemon /sessions' },
  };
  if (!analysis) {
    return { ...snapshot, transcript: null, verdict: 'unknown', verdictScope: VERDICT_SCOPE, notes: [error] };
  }
  const { notes, empty, sessionHeader, ...transcript } = analysis;
  const extraNotes = [];
  let verdict = classify(session.status, analysis);
  const headerId = sessionHeader?.id ?? null;
  if (headerId && session.nativeSessionId && headerId !== session.nativeSessionId) {
    verdict = 'unknown';
    extraNotes.push(`the transcript belongs to Pi session ${headerId}, not ${session.nativeSessionId} as ccmux reports`);
  } else if (!headerId || !session.nativeSessionId) {
    extraNotes.push('transcript identity unverified: ccmux or the transcript header gives no Pi session id');
  }
  if (empty) extraNotes.push('the transcript holds no conversation entries in the scanned part');
  if (verdict === 'reply-observed-still-working') extraNotes.push('ccmux still reports the session working; more output or a newer message may follow');
  if (verdict === 'errored-no-reply') extraNotes.push('the latest attempt ended in an error; Pi may retry automatically, so check again before treating the turn as over');
  if (verdict === 'idle-without-reply' && analysis.afterLatestUserMessage.last?.stopReason === 'toolUse') {
    extraNotes.push('ccmux reports idle but the transcript ends mid-turn (toolUse); status and transcript disagree');
  }
  if (verdict === 'no-user-message-since') extraNotes.push('no user message on the conversation path since --since: it may be queued, undelivered, in another session file, or never sent');
  return { ...snapshot, transcript: { ...transcript, sessionId: headerId, sessionStartedAt: sessionHeader?.at ?? null },
    verdict, verdictScope: VERDICT_SCOPE, notes: [...extraNotes, ...notes] };
}

/** Remove transcript text (reply body and user-message previews) for metadata-only output. */
export function withoutText(snapshot) {
  const t = snapshot.transcript;
  if (!t) return snapshot;
  return { ...snapshot, transcript: { ...t,
    latestUserMessage: t.latestUserMessage && { ...t.latestUserMessage, preview: undefined },
    latestReply: t.latestReply && { ...t.latestReply, text: undefined } } };
}

export function findSession(sessions, ref) {
  const matches = sessions.filter(session => session.id === ref || session.tmuxPane === ref || session.nativeSessionId === ref);
  if (matches.length === 1) return { session: matches[0] };
  if (matches.length === 0) return { error: `no ccmux session has exact id, pane or Pi session id "${ref}" (see ccmux show --json)` };
  return { error: `"${ref}" matches ${matches.length} sessions: ${matches.map(session => session.id).join(', ')}` };
}

/** The daemon port as ccmux resolves it (lib/config.ts parseCcmuxPort): CCMUX_PORT when valid, else 2269. */
export function daemonUrl(env = process.env) {
  const port = Number(env.CCMUX_PORT);
  return `http://127.0.0.1:${env.CCMUX_PORT && Number.isInteger(port) && port > 0 && port <= 65535 ? port : 2269}`;
}

/** Sessions from the running daemon. Unlike `ccmux show`, this never starts or replaces the daemon. */
async function daemonSessions() {
  const url = `${daemonUrl()}/sessions`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  } catch (error) {
    throw new Error(`the ccmux daemon is not reachable at ${url} (${error.cause?.code ?? error.name}); this command does not start it`);
  }
  if (!response.ok) throw new Error(`the ccmux daemon answered ${url} with HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.sessions)) throw new Error(`unexpected response from ${url}`);
  return body.sessions;
}

export async function snapshotFor(ref, { since, replyChars, maxScanBytes } = {}) {
  const found = findSession(await daemonSessions(), ref);
  if (found.error) return { error: found.error };
  const { session } = found;
  if (session.agentType !== 'pi') {
    return { snapshot: buildSnapshot(session, null, { error: `transcript reading supports Pi sessions only; this is ${session.agentType}` }) };
  }
  if (!session.logPath) return { snapshot: buildSnapshot(session, null, { error: 'ccmux reports no transcript path for this session' }) };
  let analysis;
  try {
    analysis = await analyzePiTranscript(session.logPath, { since, replyChars, maxScanBytes });
  } catch (error) {
    return { snapshot: buildSnapshot(session, null, { error: `transcript unreadable: ${error.code ?? error.message}` }) };
  }
  return { snapshot: buildSnapshot(session, analysis) };
}

export function renderText(snapshot) {
  const { session, activity, transcript: t } = snapshot;
  const lines = [
    `session ${session.id}${session.tmuxPane ? ` (${session.tmuxPane}${session.tmuxTarget ? ` ${session.tmuxTarget}` : ''})` : ''} ${session.agentType}`
      + `${session.nativeSessionId ? ` pi-session ${session.nativeSessionId}` : ''}`,
    `observed ${snapshot.observedAt}; activity ${activity.status ?? 'unknown'}${activity.statusChangedAt ? ` since ${activity.statusChangedAt}` : ''} (${activity.source})`,
  ];
  if (t) {
    lines.push(`path: from persisted leaf ${t.leafEntryId ?? 'none'}${t.leafAt ? ` at ${t.leafAt}` : ''}; unsaved /tree navigation is not visible`);
    const li = t.latestUserMessage;
    const quoted = li?.preview ? ` "${li.preview}"` : li && !li.textAvailable ? ' (too large to read)' : '';
    lines.push(li ? `latest user message: ${li.at ?? 'no timestamp'} entry ${li.entryId}${quoted}` : 'latest user message: none found');
    const after = t.afterLatestUserMessage;
    if (li) {
      lines.push(after.last ? `after it: ${after.assistantMessages} assistant message(s), newest ${after.last.stopReason} at ${after.last.at ?? 'no timestamp'}`
        : 'after it: no assistant message yet');
    }
    const reply = t.latestReply;
    lines.push(reply ? `latest finished reply: ${reply.at ?? 'no timestamp'} entry ${reply.entryId} (${reply.order})`
      + `${t.userMessagesAfterLatestReply ? `, ${t.userMessagesAfterLatestReply} user message(s) newer than it` : ''}`
      : 'latest finished reply: none found');
    if (t.sinceWindow) {
      const w = t.sinceWindow;
      const list = items => items.map(item => `${item.entryId}@${item.at}`).join(', ') || 'none';
      lines.push(`since ${w.since}: user message(s) ${list(w.userMessages)}`
        + `${w.extensionMessages.length ? `; extension message(s) ${list(w.extensionMessages)}` : ''}${w.complete ? '' : ' (window incomplete)'}`);
    }
  }
  lines.push(`verdict (persisted path, ccmux-reported activity): ${snapshot.verdict}`);
  for (const note of snapshot.notes) lines.push(`note: ${note}`);
  if (t?.latestReply?.text) {
    lines.push(`--- latest finished reply (${t.latestReply.order}${t.latestReply.textTruncated ? ', tail' : ''}) ---`, t.latestReply.text);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = { json: false, includeText: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-text') options.includeText = false;
    else if (arg === '--since' || arg === '--chars') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--since') {
        if (Number.isNaN(Date.parse(value)) || !/(Z|[+-]\d\d:?\d\d)$/.test(value)) throw new Error('--since needs an ISO time with Z or an offset');
        options.since = new Date(value).toISOString();
      } else {
        const chars = Number(value);
        if (!Number.isSafeInteger(chars) || chars < 1) throw new Error('--chars needs a positive whole number');
        options.replyChars = chars;
      }
    } else if (arg.startsWith('-') && !/^%\d+$/.test(arg)) throw new Error(`unknown option ${arg}`);
    else rest.push(arg);
  }
  if (rest.length !== 1) throw new Error('usage: session-snapshot.mjs <session-id|%pane|pi-session-id> [--since <ISO>] [--json] [--chars <n>] [--no-text]');
  return { ref: rest[0], ...options };
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(2); }
  let outcome;
  try {
    outcome = await snapshotFor(args.ref, args);
  } catch (error) {
    console.error(`session-snapshot: ${error.message}`);
    process.exit(1);
  }
  if (outcome.error) { console.error(`session-snapshot: ${outcome.error}`); process.exit(1); }
  const snapshot = args.includeText ? outcome.snapshot : withoutText(outcome.snapshot);
  console.log(args.json ? JSON.stringify(snapshot, null, 2) : renderText(snapshot));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === (await import('node:fs')).realpathSync(process.argv[1])) await main();
