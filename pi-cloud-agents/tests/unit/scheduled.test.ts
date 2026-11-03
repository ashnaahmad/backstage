import { LambdaMicrovmsClient, TerminateMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AwsClientFactory } from "../../core/aws/clients.js";
import type { LaunchRunResult, PreparedLaunch } from "../../core/launcher.js";
import { describeLaunch } from "../../scheduled/cli.js";
import { handleScheduledLaunch } from "../../scheduled/handler.js";
import {
  type ScheduledTask,
  finalAssistantMessage,
  launchKey,
  taskKey,
} from "../../scheduled/task.js";

const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);

const runId = "run-abc123-xyz";

function body(text: string) {
  return { transformToString: async () => text };
}

function task(): ScheduledTask {
  return {
    v: 1,
    jobId: "probe",
    runId,
    prompt: "say hi",
    requestedAt: "2026-10-30T21:00:00.000Z",
    scheduleName: "tick-probe",
    createdAt: "2026-10-30T20:00:00.000Z",
    prepared: {
      payload: { runId, stack: { bucket: "b", name: "s", region: "eu-north-1" } },
      manifest: { runId, createdAt: "2026-10-30T20:00:00.000Z", timeline: [] },
      region: "eu-north-1",
      profile: "local-profile",
    } as unknown as PreparedLaunch,
  };
}

function launched(promptDispatched: boolean): LaunchRunResult {
  return {
    runId,
    microvmId: "microvm-1",
    endpoint: "e",
    workBranch: "w",
    manifest: {} as LaunchRunResult["manifest"],
    warnings: promptDispatched ? [] : ["did not report ready"],
    promptDispatched,
  };
}

function putBodies(key: string) {
  return s3Mock
    .commandCalls(PutObjectCommand)
    .filter((c) => c.args[0].input.Key === key)
    .map((c) => ({
      ...JSON.parse(String(c.args[0].input.Body)),
      _ifNoneMatch: c.args[0].input.IfNoneMatch,
    }));
}

describe("scheduled launch handler", () => {
  let factory: AwsClientFactory;

  beforeEach(() => {
    s3Mock.reset();
    microvmsMock.reset();
    factory = new AwsClientFactory({ region: "eu-north-1" });
    s3Mock
      .on(GetObjectCommand, { Key: taskKey(runId) })
      .resolves({ Body: body(JSON.stringify(task())) } as never);
  });

  it("claims with a conditional create, starts with the Lambda's credentials and records Scheduler evidence", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const start = vi.fn(async () => launched(true));

    const res = await handleScheduledLaunch(
      { runId, scheduledTime: "2026-10-30T21:00:00Z", executionId: "exec-1" },
      { bucket: "b", region: "eu-north-1", factory, requestId: "req-1", start },
    );

    expect(res.outcome).toBe("launched");
    expect(start).toHaveBeenCalledTimes(1);
    const [prepared, prompt] = start.mock.calls[0] as unknown as [PreparedLaunch, string];
    expect(prompt).toBe("say hi");
    expect(prepared.profile).toBeUndefined();
    const writes = putBodies(launchKey(runId));
    expect(writes[0]).toMatchObject({ status: "claimed", _ifNoneMatch: "*" });
    expect(writes.at(-1)).toMatchObject({
      status: "launched",
      scheduledTime: "2026-10-30T21:00:00Z",
      executionId: "exec-1",
      lambdaRequestId: "req-1",
      microvmId: "microvm-1",
    });
  });

  it("does not start a second run when the claim already exists", async () => {
    s3Mock.on(PutObjectCommand).rejects(
      Object.assign(new Error("At least one of the pre-conditions you specified did not hold"), {
        name: "PreconditionFailed",
        $metadata: { httpStatusCode: 412 },
      }),
    );
    const start = vi.fn(async () => launched(true));

    const res = await handleScheduledLaunch(
      { runId },
      { bucket: "b", region: "eu-north-1", factory, start, log: () => {} },
    );

    expect(res.outcome).toBe("duplicate");
    expect(start).not.toHaveBeenCalled();
  });

  it("does not claim termination when the terminate call fails", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    microvmsMock.on(TerminateMicrovmCommand).rejects(new Error("AccessDenied"));

    await handleScheduledLaunch(
      { runId },
      {
        bucket: "b",
        region: "eu-north-1",
        factory,
        start: async () => launched(false),
        log: () => {},
      },
    );

    expect(putBodies(launchKey(runId)).at(-1)).toMatchObject({
      status: "failed",
      terminatedForFailure: false,
    });
  });

  it("terminates a VM created before the launch threw", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    microvmsMock.on(TerminateMicrovmCommand).resolves({});
    const start = async () => {
      throw Object.assign(new Error("Failed to launch MicroVM: index write"), {
        microvmId: "microvm-2",
      });
    };

    const res = await handleScheduledLaunch(
      { runId },
      { bucket: "b", region: "eu-north-1", factory, start, log: () => {} },
    );

    expect(res.outcome).toBe("failed");
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "microvm-2",
    });
    expect(putBodies(launchKey(runId)).at(-1)).toMatchObject({
      microvmId: "microvm-2",
      terminatedForFailure: true,
    });
  });

  it("terminates the VM and records failure when the prompt never reached the runner", async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    microvmsMock.on(TerminateMicrovmCommand).resolves({});

    const res = await handleScheduledLaunch(
      { runId },
      {
        bucket: "b",
        region: "eu-north-1",
        factory,
        start: async () => launched(false),
        log: () => {},
      },
    );

    expect(res.outcome).toBe("failed");
    expect(microvmsMock.commandCalls(TerminateMicrovmCommand)[0]?.args[0].input).toEqual({
      microvmIdentifier: "microvm-1",
    });
    expect(putBodies(launchKey(runId)).at(-1)).toMatchObject({
      status: "failed",
      terminatedForFailure: true,
    });
  });

  it("rejects an event whose runId is not a run id", async () => {
    await expect(
      handleScheduledLaunch(
        { runId: "../config/bundle" },
        { bucket: "b", region: "eu-north-1", factory },
      ),
    ).rejects.toThrow(/invalid scheduled launch event/);
  });
});

describe("finalAssistantMessage", () => {
  it("returns the last assistant text, ignoring thinking, tool calls and a torn final line", () => {
    const lines = [
      { type: "session" },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "q" }] } },
      {
        type: "message",
        timestamp: "t1",
        message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall" }] },
      },
      {
        type: "message",
        message: { role: "toolResult", content: [{ type: "text", text: "out" }] },
      },
      {
        type: "message",
        timestamp: "t2",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "x" },
            { type: "text", text: "DONE marker" },
          ],
        },
      },
    ].map((l) => JSON.stringify(l));
    const jsonl = `${lines.join("\n")}\n{"type":"mess`;
    expect(finalAssistantMessage(jsonl)).toEqual({
      text: "DONE marker",
      timestamp: "t2",
      stopReason: "stop",
      complete: true,
    });
  });

  it("marks a last turn that is still a tool call as incomplete rather than final", () => {
    const jsonl = [
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "earlier" }],
        },
      },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "more" }] } },
      {
        type: "message",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "text", text: "checking" }, { type: "toolCall" }],
        },
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    expect(finalAssistantMessage(jsonl)).toMatchObject({ text: "checking", complete: false });
  });

  it("returns null before the agent has answered", () => {
    expect(finalAssistantMessage(JSON.stringify({ type: "session" }))).toBeNull();
  });
});

describe("describeLaunch", () => {
  const claimed = {
    v: 1 as const,
    runId,
    status: "claimed" as const,
    invokedAt: "2026-10-30T20:00:00.000Z",
  };
  const at = (iso: string) => Date.parse(iso);

  it("reports a fresh claim as launching and a stale one as incomplete", () => {
    expect(describeLaunch(claimed, at("2026-10-30T20:05:00Z"))).toBe("launching");
    expect(describeLaunch(claimed, at("2026-10-30T20:12:00Z"))).toBe("incomplete");
  });

  it("reports finished launches and missing records as such", () => {
    expect(describeLaunch({ ...claimed, status: "launched", finishedAt: "x" })).toBe("launched");
    expect(describeLaunch(null)).toBe("not-fired");
  });
});
