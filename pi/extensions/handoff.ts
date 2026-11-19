import { StringEnum, Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Explicit handoff submission: the author names an existing Markdown handoff, its QA state and the Codex owner thread
 * from its current brief, and the owner is notified through Codex's own `codex queue`. Writing a file or finishing a
 * reply never submits anything. The tool result records what was submitted and what the transport reported; a queued
 * message is Codex's acknowledgement, not proof that the owner read, accepted or acted on the handoff.
 */
const QA_STATES = ["pending", "passed", "failed", "blocked", "not-applicable"] as const;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MARKDOWN = /\.(md|markdown)$/i;
/** Where the Codex desktop app ships its CLI on macOS; CODEX_CLI_PATH (the app's own name for it) overrides. */
const BUNDLED_CLI = "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const QUEUE_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
/** Codex 0.166 prints `Queued message <id> for thread <thread>.` on success. */
const QUEUED = /^Queued message (\S+) for thread (\S+)\.$/;

/**
 * queued: the CLI printed its acknowledgement for this thread, which is evidence of enqueueing even if the process then
 * ended abnormally (recorded as such). unconfirmed: the CLI was started but printed no acknowledgement for this thread,
 * so the message may or may not be queued. not-sent: nothing was started.
 */
type Transport = {
  status: "queued" | "unconfirmed" | "not-sent";
  cli: string | null;
  exitCode?: number | null;
  signal?: string | null;
  queuedMessageId?: string;
  output?: string;
  outputTruncated?: boolean;
  reason?: string;
};

/** The file checked is the file run: an absolute path to an executable regular file. */
const executable = async (path: string) =>
  (await stat(path).catch(() => null))?.isFile() === true && await access(path, constants.X_OK).then(() => true, () => false);

/** The configured CLI, else the first bundled one present. A configured path that does not work is not replaced. */
async function findCli(env: NodeJS.ProcessEnv): Promise<{ cli: string } | { reason: string }> {
  const configured = env.CODEX_CLI_PATH;
  if (configured !== undefined) {
    return isAbsolute(configured) && await executable(configured) ? { cli: configured }
      : { reason: `CODEX_CLI_PATH (${configured}) is not an absolute path to an executable file` };
  }
  const candidates = [join("/Applications", BUNDLED_CLI), join(env.HOME || homedir(), "Applications", BUNDLED_CLI)];
  for (const candidate of candidates) if (await executable(candidate)) return { cli: candidate };
  return { reason: `no Codex CLI found; set CODEX_CLI_PATH (looked in ${candidates.join(", ")})` };
}

/** endingObserved is false when Node reports a stop it made (output overflow) but not how the process then ended. */
type Run = { started: boolean; code: number | null; signal: string | null; endingObserved: boolean; stdout: string; stderr: string;
  stopped?: "timeout" | "cancelled" | "excess-output"; spawnError?: string };

/**
 * Run the CLI once with Node's execFile rather than pi.exec, which reports a child ended by a signal it did not send as
 * exit 0 (Pi 1.5.2). Timeout, cancellation and output overflow kill it with SIGKILL, which it cannot ignore.
 * Cancellation kills the child directly: execFile's own abort handling calls back before the child has ended.
 */
function runCli(cli: string, args: string[], signal: AbortSignal | undefined): Promise<Run> {
  return new Promise(done => {
    let cancelled = false;
    const child = execFile(cli, args, { timeout: QUEUE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      signal?.removeEventListener("abort", onAbort);
      const out = { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
      if (!error) return done({ started: true, code: 0, signal: null, endingObserved: true, ...out });
      const e = error as NodeJS.ErrnoException & { code?: string | number; signal?: string | null; killed?: boolean };
      // A failed spawn (missing file or interpreter, no permission) never ran the CLI.
      if (typeof e.syscall === "string" && e.syscall.startsWith("spawn")) {
        return done({ started: false, code: null, signal: null, endingObserved: false, ...out, spawnError: e.message });
      }
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
        return done({ started: true, code: null, signal: null, endingObserved: false, stopped: "excess-output", ...out });
      }
      done({ started: true, code: typeof e.code === "number" ? e.code : null, signal: e.signal ?? null, endingObserved: true,
        ...(cancelled ? { stopped: "cancelled" as const } : e.killed ? { stopped: "timeout" as const } : {}), ...out });
    });
    function onAbort() { cancelled = child.kill("SIGKILL"); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Complete acknowledgement lines: a line cut off by the output cap is not a receipt. */
function acknowledgements(run: Run): { messageId: string; thread: string }[] {
  const lines = run.stdout.split("\n");
  if (run.stopped === "excess-output" && !run.stdout.endsWith("\n")) lines.pop();
  return lines.map(line => line.trim().match(QUEUED)).filter((m): m is RegExpMatchArray => !!m)
    .map(m => ({ messageId: m[1], thread: m[2] }));
}

export default function handoff(pi: ExtensionAPI) {
  pi.registerTool({
    name: "submit_handoff",
    label: "Submit handoff",
    description: "Submit your existing Markdown handoff to the Codex owner named in your current brief, when the handoff is ready " +
      "for that owner to act on. Sends one notification through codex queue with the handoff path, the QA state and this session's identity, " +
      "asking the owner to read the handoff and its evidence, reconcile the landing plan and coordinate the next action. " +
      "Writing or updating the file does not submit it. Use the owner thread id from your brief; never guess one. " +
      "A queued result means Codex accepted the message, not that the owner read or accepted the handoff. " +
      "The QA state is your report: passed grants no publication or merge authority.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Path to the existing Markdown handoff (absolute, or relative to the working directory)." }),
      qaState: StringEnum(QA_STATES, { description: "QA state the handoff reports: pending, passed, failed, blocked or not-applicable." }),
      ownerThreadId: Type.String({ minLength: 1, description: "The Codex owner's thread id (UUID) exactly as given in your current brief." }),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!THREAD_ID.test(params.ownerThreadId)) {
        throw new Error(`ownerThreadId must be the owner's Codex thread UUID from your brief; got ${JSON.stringify(params.ownerThreadId)}. Nothing was sent.`);
      }
      const path = resolve(ctx.cwd, params.path);
      const file = await stat(path).catch(() => null);
      if (!file?.isFile() || !MARKDOWN.test(path)) {
        throw new Error(`${path} is not an existing Markdown file. Nothing was sent.`);
      }
      const session = ctx.sessionManager;
      const sender = {
        sessionId: session.getSessionId(),
        sessionName: session.getSessionName() ?? null,
        sessionFile: session.getSessionFile() ?? null,
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
        cwd: ctx.cwd,
        tmuxPane: process.env.TMUX_PANE ?? null,
      };
      const message = [
        `[Handoff from Pi session ${sender.sessionName ?? "(unnamed)"}: id ${sender.sessionId}, model ${sender.model ?? "unknown"}, `
          + `cwd ${sender.cwd}${sender.tmuxPane ? `, tmux pane ${sender.tmuxPane}` : ""}]`,
        `Handoff submitted: ${path}`,
        `QA state reported by the sender: ${params.qaState}. This is the sender's report; it is not readiness, publication or merge authority.`,
        "Read the handoff and the evidence it links, reconcile the relevant entry in your landing plan, and coordinate the next action. "
          + "The sender's tool only queued this message; it cannot tell whether you read or accepted the handoff.",
      ].join("\n");

      const found = await findCli(process.env);
      let transport: Transport;
      if ("reason" in found) {
        transport = { status: "not-sent", cli: null, reason: found.reason };
      } else if (signal?.aborted) {
        transport = { status: "not-sent", cli: found.cli, reason: "cancelled before codex queue was started" };
      } else {
        const run = await runCli(found.cli, ["queue", "--thread", params.ownerThreadId, "--message", message], signal);
        const output = [run.stdout.trim(), run.stderr.trim()].filter(Boolean).join("\n");
        const queued = acknowledgements(run).find(ack => ack.thread.toLowerCase() === params.ownerThreadId.toLowerCase());
        const ending = [
          run.stopped === "excess-output" ? "produced more output than expected and was killed"
            : run.stopped === "timeout" ? `did not finish within ${QUEUE_TIMEOUT_MS / 1000} s and was killed`
            : run.stopped === "cancelled" ? "was killed on cancellation" : null,
          !run.endingObserved ? "its exit status was not observed"
            : run.stopped && run.signal === "SIGKILL" ? null : run.signal ? `ended by ${run.signal}` : run.code !== 0 ? `exited ${run.code}` : null,
        ].filter(Boolean).join(", ") || null;
        if (!run.started) {
          transport = { status: "not-sent", cli: found.cli, reason: `codex queue could not be started (${run.spawnError})` };
        } else if (queued) {
          transport = { status: "queued", cli: found.cli, exitCode: run.code, signal: run.signal, queuedMessageId: queued.messageId, output,
            ...(ending ? { reason: `after acknowledging, codex queue ${ending}` } : {}),
            ...(run.stopped === "excess-output" ? { outputTruncated: true } : {}) };
        } else {
          const reason = ending ? `codex queue ${ending}` : "codex queue exited 0 without acknowledging this thread";
          transport = { status: "unconfirmed", cli: found.cli, exitCode: run.code, signal: run.signal, output, reason,
            ...(run.stopped === "excess-output" ? { outputTruncated: true } : {}) };
        }
      }

      const details = { path, qaState: params.qaState, ownerThreadId: params.ownerThreadId, sender, transport };
      const shown = transport.output ? `\nCLI output${transport.outputTruncated ? " (partial)" : ""}: ${transport.output}` : "";
      if (transport.status === "queued") {
        return { content: [{ type: "text", text: `Queued for Codex thread ${params.ownerThreadId} as message ${transport.queuedMessageId}. `
          + (transport.reason ? `Note: ${transport.reason}.${shown} ` : "")
          + "This is Codex's queue acknowledgement only: it does not show that the owner has read the handoff, accepted it or updated the landing plan." }], details };
      }
      const text = transport.status === "unconfirmed"
        ? `Delivery unconfirmed: ${transport.reason}.${shown}\nThe message may or may not be queued. Check with the owner before submitting again, which could duplicate it.`
        : `Not sent: ${transport.reason}.\nTell your orchestrator through your existing channel, or fix the cause and submit again.`;
      return { content: [{ type: "text", text }], details, isError: true };
    },
  });
}
