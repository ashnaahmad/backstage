/**
 * Scheduled one-shot tasks: the S3 records shared by the local scheduling helper (cli.ts),
 * the launch Lambda (handler.ts) and result retrieval.
 *
 * tick/tasks/<runId>/task.json    written once when the task is scheduled; the prompt and a
 *                                 PreparedLaunch (secret names, never values)
 * tick/tasks/<runId>/launch.json  created by the first launcher invocation (conditional put, so
 *                                 duplicate deliveries do not start a second VM), then updated
 *                                 with the launch outcome. At most once: if the launcher dies
 *                                 after claiming, the record stays "claimed" with no finishedAt
 *                                 and the task is not retried; readers report it incomplete.
 * runs/<runId>/session.jsonl      the runner's own session mirror; holds the final result
 */

import type { PreparedLaunch } from "../core/launcher.js";

export const TASK_PREFIX = "tick/tasks";

export function taskKey(runId: string): string {
  return `${TASK_PREFIX}/${runId}/task.json`;
}

export function launchKey(runId: string): string {
  return `${TASK_PREFIX}/${runId}/launch.json`;
}

export interface ScheduledTask {
  v: 1;
  jobId: string;
  runId: string;
  prompt: string;
  /** Requested start, UTC ISO-8601. The schedule fires at this instant (timezone UTC). */
  requestedAt: string;
  scheduleName: string;
  createdAt: string;
  prepared: PreparedLaunch;
}

export interface LaunchRecord {
  v: 1;
  runId: string;
  status: "claimed" | "launched" | "failed";
  /** Scheduler context attributes (scheduled time, execution id, attempt number). */
  scheduledTime?: string;
  executionId?: string;
  attempt?: string;
  invokedAt: string;
  lambdaRequestId?: string;
  microvmId?: string;
  promptDispatchedAt?: string;
  finishedAt?: string;
  terminatedForFailure?: boolean;
  warnings?: string[];
  error?: string;
}

export interface FinalMessage {
  text: string;
  timestamp?: string;
  stopReason?: string;
  /** False when the last assistant turn was a tool call or error: the agent had not finished. */
  complete: boolean;
}

/**
 * Returns the last assistant message in a Pi session JSONL, or null when the agent has not
 * answered. Malformed lines are skipped: the mirror can end mid-flush.
 */
export function finalAssistantMessage(sessionJsonl: string): FinalMessage | null {
  const lines = sessionJsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: { role?: string; stopReason?: string; content?: unknown };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    const text = content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("\n");
    const stopReason = entry.message.stopReason;
    return { text, timestamp: entry.timestamp, stopReason, complete: stopReason === "stop" };
  }
  return null;
}
