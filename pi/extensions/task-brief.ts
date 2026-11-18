import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Keeps an implementing session's current task brief in the model's context.
 *
 * One rule decides delivery: before a model request, if the context Pi will send lacks a restoration of the
 * current observed state, add one. The context is Pi's own projection (after compaction, /tree and context
 * edits), so a brief summarised away or left on another branch counts as absent, and an unchanged one still in
 * context is not repeated, including across /reload. Session start, resume, a new session and a fork restore
 * once more as explicit transitions.
 *
 * The coordination record (scripts/coordination-record.mjs `brief`) owns the rendering. A session is bound only
 * when the record names its native session id as implementer; names are never matched and nothing is inherited.
 * A fork keeps its parent's history, including earlier restorations, but is told it is not the implementer.
 * The record path comes from COORDINATION_RECORD or, failing that, from this session's own earlier restorations.
 */
const TYPE = "task-brief";
const CLI = fileURLToPath(new URL("../../scripts/coordination-record.mjs", import.meta.url));
const NODE = /^node(\.exe)?$/.test(basename(process.execPath)) ? process.execPath : "node";
const READ_ATTEMPTS = 3;

type Result = {
  status: "assigned" | "not-implementer" | "none" | "ambiguous" | "error" | "unconfirmed";
  assignment: string | null;
  key: string;
  text: string;
  briefPath?: string | null;
  recordedSha256?: string | null;
};
type Delivered = Result & { recordPath: string; reason: string };

const TRANSITIONS: Record<string, string | undefined> = {
  startup: "session start", resume: "session resume", new: "new session", fork: "fork", reload: undefined,
};

const restorationOf = (entry: { type: string; customType?: string; details?: Delivered }) =>
  entry.type === "custom_message" && entry.customType === TYPE && entry.details?.key ? entry.details : undefined;

export default function taskBrief(pi: ExtensionAPI) {
  let recordPath: string | undefined;
  let transition: string | undefined;
  let hint: string | undefined;
  /** The files the last accepted result depended on, and their state while it was read. */
  let observed: { files: (string | null)[]; stamp: string } | undefined;

  /** Everything this session file has received, on any branch: for the record path and an assignment once held. */
  const history = (ctx: ExtensionContext) => {
    const all = ctx.sessionManager.getEntries().map(restorationOf).filter((d): d is Delivered => !!d);
    return { recordPath: all.findLast(d => d.recordPath)?.recordPath, held: all.findLast(d => d.assignment)?.assignment ?? undefined };
  };

  /** The latest restoration in the context Pi will send now. */
  const inContext = (ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.buildSessionProjection().entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const delivered = entries[i].messages.length ? restorationOf(entries[i].sourceEntry as never) : undefined;
      if (delivered) return delivered;
    }
    return undefined;
  };

  const query = async (args: string[]): Promise<Result> => {
    const run = await pi.exec(NODE, [CLI, "brief", ...args, "--record", recordPath!, "--json"], { timeout: 10_000 });
    if (run.code === 0) {
      try { return JSON.parse(run.stdout) as Result; } catch { /* reported below */ }
    }
    const reason = (run.stderr || run.stdout).trim().split("\n")[0] || `exit ${run.code}`;
    return { status: "error", assignment: null, key: `error:${reason}`,
      text: `The coordination record ${recordPath} could not be read (${reason}), so the current brief is not restored. `
        + "That grants no permission and removes no constraint; ask the accountable orchestrator." };
  };

  /** File state, cheap to take: a record write replaces the file (new inode); a brief edit changes size or mtime. */
  const signature = async (files: (string | null)[]) => {
    const parts = await Promise.all(files.map(async path => {
      if (!path) return "-";
      try { const s = await stat(path); return `${s.ino}:${s.size}:${s.mtimeMs}`; } catch (error) { return (error as NodeJS.ErrnoException).code ?? "?"; }
    }));
    return parts.join("|");
  };

  /**
   * The only way a result is read. It is accepted only when the record and the brief it names were in the same
   * state before and after the read, so a result is never paired with a later state than the one it describes
   * (which would hide that later change from the turn-boundary check). If they keep moving, nothing is accepted.
   */
  const observe = async (ctx: ExtensionContext, held: string | undefined) => {
    const id = ctx.sessionManager.getSessionId();
    let briefPath = observed?.files[1] ?? null;
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const files = [recordPath!, briefPath];
      const before = await signature(files);
      let result = await query(["--session", id]);
      // A session that held an assignment, or a fork of one, hears that it does not hold it now.
      if (result.status === "none" && held) result = await query([held, "--session", id]);
      const after = await signature(files);
      if (before === after && (result.briefPath ?? null) === briefPath) return { result, observation: { files, stamp: after } };
      briefPath = result.briefPath ?? null;
    }
    return undefined;
  };

  /** The restoration to add before the next model request, or undefined when the context already holds it. */
  const compose = async (ctx: ExtensionContext) => {
    const past = history(ctx);
    recordPath = process.env.COORDINATION_RECORD || past.recordPath;
    if (!recordPath) return undefined;
    const seen = await observe(ctx, past.held);
    if (!seen) {
      // Still changing: confirm nothing, keep the transition, and look again at the next boundary. A restoration
      // already in context may now be stale, so the model hears that once; the next stable read replaces it.
      observed = undefined;
      if (ctx.hasUI) ctx.ui.notify("Task brief: the coordination record kept changing while being read; restoration deferred.", "warning");
      const held = inContext(ctx);
      if (!held || held.status === "unconfirmed") return undefined;
      const details: Delivered = { status: "unconfirmed", assignment: held.assignment, key: "unconfirmed", text: "", recordPath, reason: "record changing" };
      return { customType: TYPE, display: true, details, content: "Current task brief: unconfirmed.\n"
        + `The coordination record ${recordPath} kept changing while being read, so this session's current assignment and brief `
        + "could not be confirmed. The restoration earlier in this context may be out of date; treat it as unconfirmed until a "
        + "new restoration follows. That grants no permission and removes no constraint." };
    }
    const { result } = seen;
    observed = seen.observation;
    const held = inContext(ctx);
    const reason = transition ?? hint ?? (held ? "assignment changed" : "not in the current context");
    const forced = transition !== undefined;
    transition = undefined;
    hint = undefined;
    if (result.status === "none" && !past.held) return undefined;
    if (!forced && held?.key === result.key) return undefined;
    const lines = [`Current task brief, restored (${reason}).`];
    if (result.status === "assigned" && held?.assignment === result.assignment && held.recordedSha256 && result.recordedSha256
      && (held.recordedSha256 !== result.recordedSha256 || held.briefPath !== result.briefPath)) {
      lines.push(`The recorded brief has changed since the restoration earlier in this context (${held.briefPath} sha256 ${held.recordedSha256.slice(0, 12)} -> ${result.briefPath} sha256 ${result.recordedSha256.slice(0, 12)}).`);
    }
    const details: Delivered = { ...result, recordPath, reason };
    return { customType: TYPE, content: `${lines.join("\n")}\n${result.text}`, display: true, details };
  };

  pi.on("session_start", async (event) => {
    // /reload keeps the context, so it is not a transition; delivery then follows the context alone.
    transition = TRANSITIONS[event.reason];
    hint = undefined;
    observed = undefined;
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const message = await compose(ctx);
    return message ? { message } : undefined;
  });

  // A record or brief change made while the agent works reaches it before its next model request.
  pi.on("turn_end", async (event, ctx) => {
    // Every run starts with before_agent_start, which finds the record path if this session has one.
    if (!recordPath) return undefined;
    if (observed && await signature(observed.files) === observed.stamp) return undefined;
    const message = await compose(ctx);
    return message ? { entries: [...event.entries, { type: "custom_message", ...message }] } : undefined;
  });

  pi.on("session_compact", async (_event, ctx) => {
    hint = "after compaction";
    // Idle: the next prompt's check sees the compacted context. Threshold and overflow compaction run inside a run,
    // before its next request and without before_agent_start, so check now and steer.
    if (ctx.isIdle()) return;
    const message = await compose(ctx);
    if (message) pi.sendMessage(message, { deliverAs: "steer" });
  });

  pi.on("session_tree", async () => {
    hint = "tree navigation";
  });
}
