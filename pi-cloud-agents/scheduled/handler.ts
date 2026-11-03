/**
 * Launch Lambda for scheduled one-shot tasks, invoked by an EventBridge Scheduler `at()`
 * schedule. It starts the prepared run, waits for the runner to be ready and submits the
 * prompt, then returns: the run continues in its MicroVM until the run's maximum duration
 * (no earlier idle cleanup today), and the runner's terminate hook writes the session to S3.
 *
 * Duplicate deliveries (Scheduler is at-least-once) are absorbed by a conditional create of
 * launch.json; RunMicrovm's clientToken is the runId as a second guard.
 */

import { TerminateMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { AwsClientFactory } from "../core/aws/clients.js";
import { type LaunchRunResult, type PreparedLaunch, startPreparedRun } from "../core/launcher.js";
import { type LaunchRecord, type ScheduledTask, launchKey, taskKey } from "./task.js";

export interface ScheduledLaunchEvent {
  runId: string;
  scheduledTime?: string;
  executionId?: string;
  attempt?: string;
}

export interface LaunchDeps {
  bucket: string;
  region: string;
  factory: AwsClientFactory;
  requestId?: string;
  now?: () => Date;
  start?: (prepared: PreparedLaunch, prompt: string) => Promise<LaunchRunResult>;
  log?: (message: string) => void;
}

export type LaunchOutcome =
  | { outcome: "duplicate"; runId: string }
  | { outcome: "launched" | "failed"; record: LaunchRecord };

function isConditionalConflict(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "PreconditionFailed" ||
    e?.name === "ConditionalRequestConflict" ||
    e?.$metadata?.httpStatusCode === 412 ||
    e?.$metadata?.httpStatusCode === 409
  );
}

async function putJson(
  s3: S3Client,
  bucket: string,
  key: string,
  body: unknown,
  ifNoneMatch?: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(body, null, 2),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      IfNoneMatch: ifNoneMatch,
    }),
  );
}

export async function handleScheduledLaunch(
  event: ScheduledLaunchEvent,
  deps: LaunchDeps,
): Promise<LaunchOutcome> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? ((m: string) => console.log(m));
  const runId = event?.runId;
  if (typeof runId !== "string" || !/^run-[a-z0-9-]+$/.test(runId)) {
    throw new Error(`invalid scheduled launch event: runId '${String(runId)}'`);
  }
  const s3 = deps.factory.getS3Client({ region: deps.region });

  const taskObj = await s3.send(new GetObjectCommand({ Bucket: deps.bucket, Key: taskKey(runId) }));
  const task = JSON.parse((await taskObj.Body?.transformToString()) ?? "") as ScheduledTask;
  if (task.runId !== runId || task.prepared?.payload?.runId !== runId) {
    throw new Error(`task record for '${runId}' does not match its key`);
  }

  const record: LaunchRecord = {
    v: 1,
    runId,
    status: "claimed",
    scheduledTime: event.scheduledTime,
    executionId: event.executionId,
    attempt: event.attempt,
    invokedAt: now().toISOString(),
    lambdaRequestId: deps.requestId,
  };
  try {
    await putJson(s3, deps.bucket, launchKey(runId), record, "*");
  } catch (err) {
    if (isConditionalConflict(err)) {
      log(`duplicate delivery for ${runId} (execution ${event.executionId ?? "?"}); not launching`);
      return { outcome: "duplicate", runId };
    }
    throw err;
  }

  // Launch-time manifest timestamps, and the Lambda's own role rather than the scheduling profile.
  const launchIso = now().toISOString();
  const prepared: PreparedLaunch = {
    ...task.prepared,
    profile: undefined,
    manifest: {
      ...task.prepared.manifest,
      createdAt: launchIso,
      updatedAt: launchIso,
      timeline: [{ status: "launching", at: launchIso, reason: "Scheduled launch" }],
    },
  };
  const start =
    deps.start ??
    ((p: PreparedLaunch, prompt: string) =>
      startPreparedRun(p, { prompt, clientFactory: deps.factory }));

  try {
    const result = await start(prepared, task.prompt);
    record.microvmId = result.microvmId;
    record.warnings = result.warnings.length > 0 ? result.warnings : undefined;
    if (result.promptDispatched) {
      record.status = "launched";
      record.promptDispatchedAt = now().toISOString();
    } else {
      record.status = "failed";
      record.error = "runner did not accept the prompt";
      record.terminatedForFailure = await terminate(deps, result.microvmId, log);
    }
  } catch (err) {
    record.status = "failed";
    record.error = (err as Error)?.message ?? String(err);
    const microvmId = (err as { microvmId?: string })?.microvmId;
    if (microvmId) {
      record.microvmId = microvmId;
      record.terminatedForFailure = await terminate(deps, microvmId, log);
    }
  }
  record.finishedAt = now().toISOString();
  await putJson(s3, deps.bucket, launchKey(runId), record);
  log(`scheduled launch ${runId}: ${record.status}${record.error ? ` (${record.error})` : ""}`);
  return { outcome: record.status === "launched" ? "launched" : "failed", record };
}

async function terminate(
  deps: LaunchDeps,
  microvmId: string,
  log: (m: string) => void,
): Promise<boolean> {
  if (!microvmId) return false;
  try {
    await deps.factory
      .getLambdaMicrovmsClient({ region: deps.region })
      .send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    return true;
  } catch (err) {
    log(`could not terminate ${microvmId}: ${(err as Error)?.message ?? String(err)}`);
    return false;
  }
}

export async function handler(
  event: ScheduledLaunchEvent,
  context?: { awsRequestId?: string },
): Promise<LaunchOutcome> {
  const region = process.env.AWS_REGION;
  const bucket = process.env.PI_CLOUD_BUCKET;
  if (!region || !bucket) throw new Error("AWS_REGION and PI_CLOUD_BUCKET must be set");
  return handleScheduledLaunch(event, {
    bucket,
    region,
    factory: new AwsClientFactory({ region }),
    requestId: context?.awsRequestId,
  });
}
