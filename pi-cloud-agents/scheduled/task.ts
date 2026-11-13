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

export { type FinalMessage, finalAssistantMessage } from "../core/result.js";
