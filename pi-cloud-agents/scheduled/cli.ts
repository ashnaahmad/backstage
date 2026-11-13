/**
 * Local helper for scheduled one-shot cloud tasks, called by pi-tick's AWS backend.
 *
 *   node dist/scheduled/cli.js schedule '<json>'   prepare the run, store it, create the schedule
 *   node dist/scheduled/cli.js cancel   '<json>'   delete the schedule (no-op once it has fired)
 *   node dist/scheduled/cli.js result   '<json>'   launch record, run status and final message
 *
 * Prints one JSON object to stdout. Exit 0 with { ok: true, ... } or 1 with { ok: false, error }.
 */

import { DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  SchedulerClient,
} from "@aws-sdk/client-scheduler";
import { AwsClientFactory } from "../core/aws/clients.js";
import { loadLocalConfig } from "../core/config.js";
import { prepareCloudRun } from "../core/launcher.js";
import { describeRecovery, describeResult } from "../core/result.js";
import { effectiveRunStatus } from "../core/status.js";
import type { RunManifest } from "../shared/protocol.js";
import {
  type LaunchRecord,
  type ScheduledTask,
  finalAssistantMessage,
  launchKey,
  taskKey,
} from "./task.js";

export const DEFAULT_LAUNCHER_STACK = "pi-tick-aws";
/** Hard lifetime bound; settled interactive turns use the existing idle/suspend policy. */
export const DEFAULT_MAX_DURATION_SEC = 1800;
const MAX_DURATION_CAP_SEC = 8 * 3600;

interface Context {
  region: string;
  profile?: string;
  factory: AwsClientFactory;
  scheduler: SchedulerClient;
  bucket?: string;
}

function context(): Context {
  const config = loadLocalConfig({ customDir: process.env.PI_AGENT_DIR });
  const region = config.aws.region || "us-east-1";
  const profile = config.aws.profile;
  return {
    region,
    profile,
    factory: new AwsClientFactory({ region, profile }),
    scheduler: new SchedulerClient({ region, profile }),
  };
}

async function launcherStack(ctx: Context) {
  const stackName = process.env.PI_TICK_AWS_STACK || DEFAULT_LAUNCHER_STACK;
  const res = await ctx.factory
    .getCloudFormationClient({ region: ctx.region, profile: ctx.profile })
    .send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs = res.Stacks?.[0]?.Outputs ?? [];
  const get = (key: string) => {
    const value = outputs.find((o) => o.OutputKey === key)?.OutputValue;
    if (!value) throw new Error(`stack '${stackName}' has no output '${key}'; deploy it first`);
    return value;
  };
  return {
    launcherArn: get("LauncherFunctionArn"),
    schedulerRoleArn: get("SchedulerRoleArn"),
    groupName: get("ScheduleGroupName"),
    bucket: get("BucketName"),
  };
}

export function scheduleNameFor(jobId: string): string {
  const name = `tick-${jobId}`;
  if (!/^[0-9A-Za-z_.-]{1,64}$/.test(name)) {
    throw new Error(`job id '${jobId}' cannot form a schedule name (max 59 characters)`);
  }
  return name;
}

/** `at()` takes local date-time fields; with timezone UTC they are the UTC instant. */
export function atExpression(requestedAt: string): string {
  const instant = new Date(requestedAt);
  if (!Number.isFinite(instant.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(requestedAt)) {
    throw new Error(`requested time '${requestedAt}' must be ISO-8601 with an explicit offset`);
  }
  return `at(${instant.toISOString().slice(0, 19)})`;
}

function parseModel(model?: string | null) {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0) throw new Error(`model '${model}' must be '<provider>/<id>'`);
  return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

async function readJson<T>(ctx: Context, bucket: string, key: string): Promise<T | null> {
  const text = await readText(ctx, bucket, key);
  return text === null ? null : (JSON.parse(text) as T);
}

async function readText(ctx: Context, bucket: string, key: string): Promise<string | null> {
  try {
    const res = await ctx.factory
      .getS3Client({ region: ctx.region, profile: ctx.profile })
      .send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString()) ?? null;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

export async function schedule(input: {
  jobId: string;
  prompt: string;
  cwd: string;
  at: string;
  model?: string | null;
  maxDurationSec?: number;
}) {
  const ctx = context();
  const scheduleName = scheduleNameFor(input.jobId);
  const expression = atExpression(input.at);
  const requestedAt = new Date(input.at).toISOString();
  if (new Date(requestedAt).getTime() <= Date.now())
    throw new Error("requested time is in the past");
  const maxDurationSec = Math.min(
    input.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC,
    MAX_DURATION_CAP_SEC,
  );

  const stack = await launcherStack(ctx);
  const { prepared, warnings } = await prepareCloudRun({
    repoDir: input.cwd,
    clientFactory: ctx.factory,
    model: parseModel(input.model),
    maxDurationSec,
    autoPush: false,
  });
  if (prepared.egressConnectorArn) {
    throw new Error(
      "a custom egress connector is configured; the scheduled launcher passes only AWS-managed connectors",
    );
  }
  if (prepared.payload.stack.bucket !== stack.bucket) {
    throw new Error(
      `launcher stack bucket '${stack.bucket}' differs from the cloud-agents bucket '${prepared.payload.stack.bucket}'`,
    );
  }
  const runId = prepared.payload.runId;
  const task: ScheduledTask = {
    v: 1,
    jobId: input.jobId,
    runId,
    prompt: input.prompt,
    requestedAt,
    scheduleName,
    createdAt: new Date().toISOString(),
    prepared,
  };
  await ctx.factory.getS3Client({ region: ctx.region, profile: ctx.profile }).send(
    new PutObjectCommand({
      Bucket: stack.bucket,
      Key: taskKey(runId),
      Body: JSON.stringify(task, null, 2),
      ContentType: "application/json",
      ServerSideEncryption: "AES256",
      IfNoneMatch: "*",
    }),
  );
  const created = await ctx.scheduler.send(
    new CreateScheduleCommand({
      Name: scheduleName,
      GroupName: stack.groupName,
      Description: `pi-tick one-shot '${input.jobId}' (${runId})`,
      ScheduleExpression: expression,
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" },
      ActionAfterCompletion: "DELETE",
      State: "ENABLED",
      Target: {
        Arn: stack.launcherArn,
        RoleArn: stack.schedulerRoleArn,
        Input: JSON.stringify({
          runId,
          scheduledTime: "<aws.scheduler.scheduled-time>",
          executionId: "<aws.scheduler.execution-id>",
          attempt: "<aws.scheduler.attempt-number>",
        }),
        RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 900 },
      },
    }),
  );
  return {
    runId,
    scheduleName,
    scheduleArn: created.ScheduleArn,
    requestedAt,
    expression,
    timezone: "UTC",
    maxDurationSec,
    repo: prepared.payload.repo,
    model: prepared.payload.model,
    warnings,
  };
}

export async function cancel(input: { jobId: string }) {
  const ctx = context();
  const stack = await launcherStack(ctx);
  const scheduleName = scheduleNameFor(input.jobId);
  try {
    await ctx.scheduler.send(
      new DeleteScheduleCommand({ Name: scheduleName, GroupName: stack.groupName }),
    );
    return { scheduleName, deleted: true };
  } catch (err) {
    if ((err as { name?: string })?.name === "ResourceNotFoundException") {
      return { scheduleName, deleted: false };
    }
    throw err;
  }
}

/** The launch Lambda's timeout (template.yaml) plus a margin for the final record write. */
const LAUNCHER_DEADLINE_MS = (600 + 60) * 1000;

/**
 * A claim without finishedAt is "launching" while the Lambda may still be running, then
 * "incomplete": the launcher stopped after claiming, and the task is not retried.
 */
export function describeLaunch(launch: LaunchRecord | null, now = Date.now()): string {
  if (!launch) return "not-fired";
  if (launch.status !== "claimed" || launch.finishedAt) return launch.status;
  const invokedAt = Date.parse(launch.invokedAt);
  return Number.isFinite(invokedAt) && now - invokedAt < LAUNCHER_DEADLINE_MS
    ? "launching"
    : "incomplete";
}

export async function result(input: { runId: string; jobId?: string }) {
  if (!/^run-[a-z0-9-]+$/.test(input.runId)) throw new Error(`invalid runId '${input.runId}'`);
  const ctx = context();
  const stack = await launcherStack(ctx);
  const task = await readJson<ScheduledTask>(ctx, stack.bucket, taskKey(input.runId));
  const launch = await readJson<LaunchRecord>(ctx, stack.bucket, launchKey(input.runId));
  const manifest = await readJson<RunManifest>(
    ctx,
    stack.bucket,
    `runs/${input.runId}/manifest.json`,
  );
  const session = await readText(ctx, stack.bucket, `runs/${input.runId}/session.jsonl`);

  let schedulePresent: boolean | undefined;
  if (task) {
    try {
      await ctx.scheduler.send(
        new GetScheduleCommand({ Name: task.scheduleName, GroupName: stack.groupName }),
      );
      schedulePresent = true;
    } catch (err) {
      if ((err as { name?: string })?.name !== "ResourceNotFoundException") throw err;
      schedulePresent = false;
    }
  }

  const microvmId = launch?.microvmId ?? manifest?.microvmId;
  let vm: Record<string, unknown> | undefined;
  if (microvmId) {
    try {
      const desc = await ctx.factory
        .getLambdaMicrovmsClient({ region: ctx.region, profile: ctx.profile })
        .send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
      vm = {
        microvmId,
        state: desc.state,
        startedAt: desc.startedAt,
        terminatedAt: desc.terminatedAt,
      };
    } catch (err) {
      vm = { microvmId, error: (err as Error)?.message ?? String(err) };
    }
  }

  const launchState = describeLaunch(launch);
  const final = session ? finalAssistantMessage(session) : null;
  const resultState = describeResult(
    manifest?.status ?? "launching",
    final,
    effectiveRunStatus(
      manifest?.status ?? "launching",
      typeof vm?.state === "string" ? vm.state : undefined,
    ),
  );

  return {
    runId: input.runId,
    jobId: task?.jobId,
    launchState,
    requestedAt: task?.requestedAt,
    schedulePresent,
    launch,
    run: manifest
      ? { status: manifest.status, timeline: manifest.timeline, error: manifest.error }
      : null,
    recovery: manifest ? describeRecovery(manifest, stack.bucket) : null,
    vm,
    resultState,
    final: final ? { ...final, complete: resultState === "settled" } : null,
  };
}

const COMMANDS: Record<string, (input: never) => Promise<unknown>> = { schedule, cancel, result };

async function main(argv: string[]) {
  const [command, raw] = argv;
  const fn = command ? COMMANDS[command] : undefined;
  if (!fn) throw new Error(`usage: cli.js <${Object.keys(COMMANDS).join("|")}> '<json>'`);
  return fn(JSON.parse(raw ?? "{}") as never);
}

if (process.argv[1]?.endsWith("cli.js") || process.argv[1]?.endsWith("cli.ts")) {
  main(process.argv.slice(2)).then(
    (out) => {
      process.stdout.write(`${JSON.stringify({ ok: true, ...(out as object) })}\n`);
    },
    (err) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: (err as Error)?.message ?? String(err) })}\n`,
      );
      process.exitCode = 1;
    },
  );
}
