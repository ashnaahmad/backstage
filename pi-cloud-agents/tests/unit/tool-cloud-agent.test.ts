/**
 * Unit tests for Cloud Agent Tool for Local LLM (T4.9).
 * Tests registration, parameter validation, prompt guidelines, truncation,
 * execution of all actions (launch, status, result, steer, stop), and rendering.
 */

import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import {
  GetMicrovmCommand,
  type GetMicrovmCommandOutput,
  LambdaMicrovmsClient,
  TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
  GetObjectCommand,
  type GetObjectCommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunClient } from "../../core/client/run-client.js";
import * as launcherModule from "../../core/launcher.js";
import {
  type CloudAgentAction,
  executeCloudAgentTool,
  registerCloudAgentTool,
  truncateToolOutput,
} from "../../extension/tools/cloud-agent.js";
import { GLYPHS } from "../../extension/ui/kit.js";
import type { RunManifest } from "../../shared/protocol.js";

const s3Mock = mockClient(S3Client);
const microvmsMock = mockClient(LambdaMicrovmsClient);
const cfnMock = mockClient(CloudFormationClient);

interface MockSdkStream {
  transformToString: () => Promise<string>;
}

function mockS3Body(content: string): MockSdkStream {
  return {
    transformToString: async () => content,
  };
}

const activeManifest: RunManifest = {
  v: 1,
  runId: "run-20260906-7f3a2c",
  owner: "user-ant",
  status: "running",
  createdAt: "2026-09-06T12:00:00.000Z",
  updatedAt: "2026-09-06T12:42:00.000Z",
  microvmId: "mvm-0123456789abcdef0",
  endpoint: "mvm-0123456789abcdef0.microvm.us-east-1.amazonaws.com",
  imageVersion: "12",
  repo: {
    url: "https://github.com/acme/api.git",
    ref: "main",
    workBranch: "pi-cloud/7f3a2c",
  },
  git: {
    workBranch: "pi-cloud/7f3a2c",
    prUrl: "https://github.com/acme/api/pull/42",
  },
  model: {
    provider: "anthropic",
    id: "claude-sonnet-4-5",
  },
  usage: {
    inputTokens: 184000,
    outputTokens: 21000,
    totalTokens: 205000,
    estimatedCostUsd: 0.86,
  },
  timeline: [
    { status: "launching", at: "2026-09-06T12:00:00.000Z" },
    { status: "running", at: "2026-09-06T12:00:30.000Z" },
  ],
};

describe("T4.9 Cloud Agent Tool for Local LLM", () => {
  beforeEach(() => {
    s3Mock.reset();
    microvmsMock.reset();
    cfnMock.reset();

    cfnMock.on(DescribeStacksCommand).resolves({
      Stacks: [
        {
          StackName: "pi-cloud-agents-core",
          StackStatus: "CREATE_COMPLETE",
          Outputs: [
            { OutputKey: "BucketName", OutputValue: "pi-cloud-agents-bucket" },
            { OutputKey: "SecretsPrefix", OutputValue: "pi-cloud-agents/" },
          ],
          CreationTime: new Date(),
        },
      ],
    });

    s3Mock.on(GetObjectCommand).resolves({
      Body: mockS3Body(JSON.stringify(activeManifest)) as unknown as GetObjectCommandOutput["Body"],
    });

    s3Mock.on(PutObjectCommand).resolves({});

    microvmsMock.on(GetMicrovmCommand).resolves({
      state: "RUNNING",
      memorySizeInMib: 2048,
      vcpuCount: 2,
      createdAt: new Date("2026-09-06T12:00:00.000Z"),
    } as unknown as GetMicrovmCommandOutput);
  });

  describe("truncateToolOutput", () => {
    it("preserves text within limits", () => {
      const text = "Short output\nLine 2\nLine 3";
      const result = truncateToolOutput(text, { maxBytes: 1000, maxLines: 100 });
      expect(result.truncated).toBe(false);
      expect(result.content).toBe(text);
      expect(result.originalLines).toBe(3);
    });

    it("truncates by lines when exceeding maxLines", () => {
      const text = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join("\n");
      const result = truncateToolOutput(text, { maxBytes: 10000, maxLines: 10 });
      expect(result.truncated).toBe(true);
      expect(result.content).toContain("[Output truncated to");
      expect(result.content.split("\n").length).toBeLessThan(20);
    });

    it("truncates by bytes when exceeding maxBytes", () => {
      const text = "A".repeat(2000);
      const result = truncateToolOutput(text, { maxBytes: 100, maxLines: 1000 });
      expect(result.truncated).toBe(true);
      expect(result.content).toContain("[Output truncated to");
    });
  });

  describe("executeCloudAgentTool actions", () => {
    it("handles cancellation via AbortSignal", async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await executeCloudAgentTool(
        "call-1",
        { action: "launch", prompt: "Build feature" },
        controller.signal,
      );
      expect(result.details.cancelled).toBe(true);
      expect(result.content[0]?.text).toContain("cancelled");
    });

    it("validates missing prompt on launch action", async () => {
      const result = await executeCloudAgentTool("call-1", { action: "launch" });
      expect(result.details.error).toBe("MISSING_PROMPT");
      expect(result.content[0]?.text).toContain("Error: 'prompt' parameter is required");
    });

    it("executes launch action successfully", async () => {
      const launchSpy = vi.spyOn(launcherModule, "launchCloudRun").mockResolvedValueOnce({
        runId: "run-20260906-launch123",
        microvmId: "mvm-launch123",
        endpoint: "mvm-launch123.microvm.us-east-1.amazonaws.com",
        workBranch: "pi-cloud/launch123",
        warnings: [],
        manifest: {
          ...activeManifest,
          runId: "run-20260906-launch123",
          repo: {
            url: "https://github.com/acme/api.git",
            ref: "main",
            workBranch: "pi-cloud/launch123",
          },
        },
      });

      const result = await executeCloudAgentTool("call-2", {
        action: "launch",
        prompt: "Refactor auth middleware to use JWT",
        model: "anthropic/claude-sonnet-4-5",
        autoPush: false,
      });

      expect(result.details.action).toBe("launch");
      expect(result.details.runId).toBe("run-20260906-launch123");
      expect(result.details.branch).toBe("pi-cloud/launch123");
      expect(result.content[0]?.text).toContain("Cloud agent launched successfully.");
      expect(result.content[0]?.text).toContain("run-20260906-launch123");
      expect(result.content[0]?.text).toContain("Next steps:");
      expect(launchSpy).toHaveBeenCalledWith(expect.objectContaining({ autoPush: false }));
      launchSpy.mockRestore();
    });

    it("validates missing runId on status, result, steer, stop actions", async () => {
      for (const action of ["status", "result", "steer", "stop"] as const) {
        const result = await executeCloudAgentTool("call-x", { action, prompt: "test" });
        expect(result.details.error).toBe("MISSING_RUN_ID");
        expect(result.content[0]?.text).toContain("Error: 'runId' parameter is required");
      }
    });

    it("executes status action successfully", async () => {
      const result = await executeCloudAgentTool("call-3", {
        action: "status",
        runId: "run-20260906-7f3a2c",
      });

      expect(result.details.action).toBe("status");
      expect(result.details.runId).toBe("run-20260906-7f3a2c");
      expect(result.content[0]?.text).toContain("Run: 7f3a2c");
      expect(result.content[0]?.text).toContain("State: running");
    });

    it("executes result action and includes PR URL and summary", async () => {
      const completedManifest: RunManifest = {
        ...activeManifest,
        git: {
          ...activeManifest.git!,
          lastCommit: "a".repeat(40),
          recovery: {
            key: `runs/${activeManifest.runId}/artifacts/git-${"b".repeat(64)}.bundle`,
            commit: "a".repeat(40),
            sha256: "b".repeat(64),
          },
        },
        status: "completed",
        timeline: [
          { status: "launching", at: "2026-09-06T12:00:00.000Z" },
          {
            status: "completed",
            at: "2026-09-06T12:45:00.000Z",
            reason: "Added 12 new unit tests and fixed token refresh bug in auth service.",
          },
        ],
      };

      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(
          JSON.stringify(completedManifest),
        ) as unknown as GetObjectCommandOutput["Body"],
      });

      s3Mock
        .on(GetObjectCommand, { Key: `runs/${completedManifest.runId}/session.jsonl` })
        .resolves({
          Body: mockS3Body(
            JSON.stringify({
              type: "message",
              message: {
                role: "assistant",
                stopReason: "stop",
                content: [
                  { type: "text", text: "Actual assistant handoff, not a timeline summary" },
                ],
              },
            }),
          ) as unknown as GetObjectCommandOutput["Body"],
        });
      const result = await executeCloudAgentTool("call-4", {
        action: "result",
        runId: "run-20260906-7f3a2c",
      });

      expect(result.details.action).toBe("result");
      expect(result.details.status).toBe("completed");
      expect(result.details.prUrl).toBe("https://github.com/acme/api/pull/42");
      expect(result.content[0]?.text).toContain("Cloud Agent Execution Report");
      expect(result.content[0]?.text).toContain("PR URL: https://github.com/acme/api/pull/42");
      expect(result.content[0]?.text).toContain("Actual assistant handoff");
      expect(result.content[0]?.text).not.toContain("Added 12 new unit tests");
      expect(result.details.resultState).toBe("settled");
      expect(result.details.recovery).toMatchObject({ current: true, commit: "a".repeat(40) });
      expect(result.content[0]?.text).toContain("Git recovery: s3://pi-cloud-agents-bucket/runs/");
    });

    it("returns a durable settled answer without waiting for VM termination", async () => {
      const idleManifest = { ...activeManifest, status: "idle" };
      s3Mock.on(GetObjectCommand).resolves({
        Body: mockS3Body(JSON.stringify(idleManifest)) as unknown as GetObjectCommandOutput["Body"],
      });
      s3Mock.on(GetObjectCommand, { Key: `runs/${activeManifest.runId}/session.jsonl` }).resolves({
        Body: mockS3Body(
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Durable read-only result" }],
            },
          }),
        ) as unknown as GetObjectCommandOutput["Body"],
      });
      const result = await executeCloudAgentTool("idle-result", {
        action: "result",
        runId: activeManifest.runId,
        wait: true,
        timeoutSeconds: 0,
      });
      expect(result.details.status).toBe("idle");
      expect(result.details.resultState).toBe("settled");
      expect(result.content[0]?.text).toContain("Durable read-only result");
    });

    it("does not call a running or terminated incomplete turn settled", async () => {
      s3Mock.on(GetObjectCommand, { Key: `runs/${activeManifest.runId}/session.jsonl` }).resolves({
        Body: mockS3Body(
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              stopReason: "toolUse",
              content: [{ type: "text", text: "Still working" }],
            },
          }),
        ) as unknown as GetObjectCommandOutput["Body"],
      });
      const pending = await executeCloudAgentTool("pending", {
        action: "result",
        runId: activeManifest.runId,
        wait: true,
        timeoutSeconds: 0,
      });
      expect(pending.details.resultState).toBe("pending");
      s3Mock.on(GetObjectCommand, { Key: `runs/${activeManifest.runId}/manifest.json` }).resolves({
        Body: mockS3Body(
          JSON.stringify({ ...activeManifest, status: "terminated" }),
        ) as unknown as GetObjectCommandOutput["Body"],
      });
      const terminated = await executeCloudAgentTool("terminated", {
        action: "result",
        runId: activeManifest.runId,
      });
      expect(terminated.details.resultState).toBe("incomplete");
      expect(terminated.details.status).toBe("terminated");
    });

    it("stops waiting when AWS reports termination even if the saved manifest is still running", async () => {
      microvmsMock.on(GetMicrovmCommand).resolves({
        microvmId: activeManifest.microvmId,
        state: "TERMINATED",
      } as unknown as GetMicrovmCommandOutput);
      s3Mock
        .on(GetObjectCommand, { Key: `runs/${activeManifest.runId}/session.jsonl` })
        .rejects(Object.assign(new Error("not uploaded"), { name: "NoSuchKey" }));
      const result = await executeCloudAgentTool("lost-hook", {
        action: "result",
        runId: activeManifest.runId,
        wait: true,
        timeoutSeconds: 0,
      });
      expect(result.details.status).toBe("terminated");
      expect(result.details.resultState).toBe("incomplete");
    });

    it("keeps an earlier answer as incomplete evidence when a newer running assignment loses its VM", async () => {
      microvmsMock.on(GetMicrovmCommand).resolves({
        microvmId: activeManifest.microvmId,
        state: "TERMINATED",
      } as unknown as GetMicrovmCommandOutput);
      // Saved running is newer than this transcript: the follow-up's user/message
      // records had not reached storage before abrupt VM loss.
      s3Mock.on(GetObjectCommand, { Key: `runs/${activeManifest.runId}/session.jsonl` }).resolves({
        Body: mockS3Body(
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Answer to FIRST assignment" }],
            },
          }),
        ) as unknown as GetObjectCommandOutput["Body"],
      });
      const result = await executeCloudAgentTool("interrupted-followup", {
        action: "result",
        runId: activeManifest.runId,
      });
      expect(result.details.status).toBe("terminated");
      expect(result.details.resultState).toBe("incomplete");
      expect(result.details.final).toMatchObject({
        text: "Answer to FIRST assignment",
        complete: false,
      });
    });

    it("waits for durable settlement rather than VM termination", async () => {
      s3Mock
        .on(GetObjectCommand, { Key: `runs/${activeManifest.runId}/manifest.json` })
        .resolvesOnce({
          Body: mockS3Body(
            JSON.stringify(activeManifest),
          ) as unknown as GetObjectCommandOutput["Body"],
        })
        .resolves({
          Body: mockS3Body(
            JSON.stringify({ ...activeManifest, status: "idle" }),
          ) as unknown as GetObjectCommandOutput["Body"],
        });
      s3Mock.on(GetObjectCommand, { Key: `runs/${activeManifest.runId}/session.jsonl` }).resolves({
        Body: mockS3Body(
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Settled after polling" }],
            },
          }),
        ) as unknown as GetObjectCommandOutput["Body"],
      });
      const result = await executeCloudAgentTool("poll", {
        action: "result",
        runId: activeManifest.runId,
        wait: true,
        timeoutSeconds: 0.05,
      });
      expect(result.details.status).toBe("idle");
      expect(result.details.resultState).toBe("settled");
      expect(result.content[0]?.text).toContain("Settled after polling");
    });

    it("executes steer action with steer mode and follow-up mode", async () => {
      const promptSpy = vi
        .spyOn(RunClient.prototype, "prompt")
        .mockResolvedValue({ status: "accepted" });

      const steerRes = await executeCloudAgentTool("call-5", {
        action: "steer",
        runId: "run-20260906-7f3a2c",
        prompt: "Focus on unit tests first",
      });
      expect(steerRes.details.action).toBe("steer");
      expect(steerRes.details.status).toBe("dispatched");
      expect(steerRes.details.dispatchedLive).toBe(true);
      expect(steerRes.details.followUp).toBe(false);
      expect(steerRes.content[0]?.text).toContain("steer mode");
      expect(steerRes.content[0]?.text).toContain("live connected");

      const followUpRes = await executeCloudAgentTool("call-6", {
        action: "steer",
        runId: "run-20260906-7f3a2c",
        prompt: "Also check lint warnings",
        followUp: true,
      });
      expect(followUpRes.details.followUp).toBe(true);
      expect(followUpRes.details.status).toBe("dispatched");
      expect(followUpRes.details.dispatchedLive).toBe(true);
      expect(followUpRes.content[0]?.text).toContain("follow-up mode");
      expect(followUpRes.content[0]?.text).toContain("live connected");

      promptSpy.mockRestore();
    });

    it("returns explicit failure status when steer dispatch fails", async () => {
      const promptSpy = vi
        .spyOn(RunClient.prototype, "prompt")
        .mockRejectedValue(new Error("Connection refused"));

      const failRes = await executeCloudAgentTool("call-5-fail", {
        action: "steer",
        runId: "run-20260906-7f3a2c",
        prompt: "Focus on unit tests first",
      });

      expect(failRes.details.action).toBe("steer");
      expect(failRes.details.status).toBe("failed");
      expect(failRes.details.error).toBe("DISPATCH_FAILED");
      expect(failRes.details.dispatchedLive).toBe(false);
      const text = failRes.content[0]?.text ?? "";
      expect(text).toContain("Failed to dispatch steer prompt");
      // what failed -> why (code) -> what to do next
      expect(text).toContain("Connection refused");
      expect(text).toContain("(DISPATCH_FAILED)");
      expect(text).toMatch(/Next: .*cloud_agent\(action="status"/);

      promptSpy.mockRestore();
    });

    it("executes stop action and terminates run", async () => {
      microvmsMock.on(TerminateMicrovmCommand).resolves({});

      const result = await executeCloudAgentTool("call-7", {
        action: "stop",
        runId: "run-20260906-7f3a2c",
      });

      expect(result.details.action).toBe("stop");
      expect(result.content[0]?.text).toContain("stopped");
    });

    it("handles unknown action error", async () => {
      const result = await executeCloudAgentTool("call-8", {
        action: "invalid_action" as unknown as CloudAgentAction,
      });
      expect(result.details.error).toBe("INVALID_ACTION");
      expect(result.content[0]?.text).toContain("Error: Unknown action");
    });
  });

  describe("registerCloudAgentTool on ExtensionAPI", () => {
    it("registers tool with description, promptGuidelines, and renderers", () => {
      let registeredTool: {
        name?: string;
        label?: string;
        promptSnippet?: string;
        promptGuidelines?: string[];
        renderCall?: (args: unknown) => { text: string };
        renderResult?: (result: unknown) => { text: string };
      } | null = null;

      const mockPi: Partial<ExtensionAPI> = {
        registerTool: (tool: unknown) => {
          registeredTool = tool as typeof registeredTool;
        },
      };

      registerCloudAgentTool(mockPi as ExtensionAPI);

      expect(registeredTool).not.toBeNull();
      expect(registeredTool!.name).toBe("cloud_agent");
      expect(registeredTool!.label).toBe("Cloud Agent");
      expect(registeredTool!.promptSnippet).toBe(
        "Delegate coding tasks to an isolated AWS MicroVM cloud agent",
      );
      expect(registeredTool!.promptGuidelines).toBeInstanceOf(Array);
      expect(registeredTool!.promptGuidelines![0]).toContain("Use cloud_agent to delegate");

      // Verify renderCall
      const renderedCallLaunch = registeredTool!.renderCall!({
        action: "launch",
        prompt: "Test task",
      });
      expect(renderedCallLaunch.text).toContain(
        `cloud_agent ${GLYPHS.arrowRight} launch: "Test task"`,
      );

      const renderedCallStatus = registeredTool!.renderCall!({
        action: "status",
        runId: "run-20260906-7f3a2c",
      });
      expect(renderedCallStatus.text).toContain(`cloud_agent ${GLYPHS.arrowRight} status run-2026`);

      // Verify renderResult
      const renderedResultLaunch = registeredTool!.renderResult!({
        details: { action: "launch", runId: "run-20260906-7f3a2c", branch: "pi-cloud/7f3a2c" },
      });
      expect(renderedResultLaunch.text).toContain("Launched cloud run");

      const renderedResultResult = registeredTool!.renderResult!({
        details: { action: "result", runId: "run-20260906-7f3a2c", status: "completed" },
      });
      expect(renderedResultResult.text).toContain("Result for run-2026: completed");
    });
  });
});
