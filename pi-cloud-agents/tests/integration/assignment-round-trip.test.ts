import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDeterministicTar } from "../../core/pi-config.js";
import { describeResult, finalAssistantMessage } from "../../core/result.js";
import { RunnerServer } from "../../runner/main.js";
import { FakeSecretsProvider } from "../../runner/secrets.js";
import { LocalStorageSink } from "../../runner/storage.js";
import {
  type LaunchPayload,
  RunnerStatusSchema,
  decodeRunManifest,
} from "../../shared/protocol.js";

describe("personal assignment runner round trip (no AWS or model network)", () => {
  it("durably returns settled and clean turns before finalization, preserves follow-ups and reports attached mirrors", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "assignment-round-trip-"));
    const seed = path.join(tmp, "seed");
    const remote = path.join(tmp, "remote.git");
    const sink = new LocalStorageSink({ baseDir: path.join(tmp, "storage") });
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    fs.mkdirSync(seed);
    git(tmp, "init", "--bare", "-b", "main", remote);
    git(seed, "init", "-b", "main");
    git(seed, "config", "user.name", "Test Agent");
    git(seed, "config", "user.email", "test@example.com");
    fs.writeFileSync(path.join(seed, "README.md"), "Assignment fixture\n");
    git(seed, "add", ".");
    git(seed, "commit", "-m", "initial");
    git(seed, "remote", "add", "origin", remote);
    git(seed, "push", "origin", "main");
    const pinned = git(seed, "rev-parse", "HEAD");
    await sink.putObject(
      "config/bundle.tar",
      createDeterministicTar([{ name: "settings.json", content: "{}" }]),
    );
    const runner = new RunnerServer({
      hookPort: 0,
      apiPort: 0,
      hookHost: "127.0.0.1",
      apiHost: "127.0.0.1",
      storageSink: sink,
      secretsProvider: new FakeSecretsProvider(new Map()),
      workDir: path.join(tmp, "work"),
      sessionDir: path.join(tmp, "sessions"),
      piAgentDir: path.join(tmp, "agent"),
      piBinary: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
      extensions: [path.resolve("runner/pi-extensions/mock-llm.ts")],
    });
    let mirror: AbortController | undefined;
    try {
      const { hookPort } = await runner.start();
      const payload: LaunchPayload = {
        v: 1,
        runId: "run-round-trip",
        owner: "personal-test",
        stack: { name: "test", region: "us-east-1", bucket: "fake" },
        repo: {
          url: `file://${remote}`,
          ref: pinned,
          depth: 1,
          workBranch: "pi-cloud/run-round-trip",
        },
        model: { provider: "mock-llm", id: "scripted" },
        piConfig: { bundleKey: "config/bundle.tar", authParams: [], bedrockRole: false },
        github: { mode: "none" },
        options: {
          installTimeoutSec: 10,
          trustProjectConfig: false,
          idleGraceSec: 0,
          suspendAfterIdleSec: 0,
          terminateAfterSuspendedSec: 60,
          autoPush: false,
          maxDurationSec: 3600,
        },
        logGroup: "fake",
      };
      const hook = await fetch(`http://127.0.0.1:${hookPort}/aws/lambda-microvms/runtime/v1/run`, {
        method: "POST",
        body: JSON.stringify({ microvmId: "local-vm", runHookPayload: JSON.stringify(payload) }),
      });
      expect(hook.status).toBe(200);
      await runner.waitForProvisioning();
      expect(runner.isReady()).toBe(true);
      const url = `http://127.0.0.1:${runner.getApiServer()!.getPort()}`;
      const status = async () =>
        RunnerStatusSchema.parse(await (await fetch(`${url}/v1/status`)).json());
      const manifest = async () =>
        decodeRunManifest((await sink.getObject("runs/run-round-trip/manifest.json")).toString());
      const transcript = async () =>
        (await sink.getObject("runs/run-round-trip/session.jsonl")).toString();
      const prompt = async (message: string) => {
        const res = await fetch(`${url}/v1/prompt`, {
          method: "POST",
          body: JSON.stringify({ message, mode: "prompt" }),
        });
        expect(res.status).toBe(200);
        await expect.poll(async () => (await manifest()).status, { timeout: 10000 }).toBe("idle");
      };
      await prompt("Create hello.txt");
      const first = await manifest();
      expect(finalAssistantMessage(await transcript())).toMatchObject({
        complete: true,
        text: "Done: created hello.txt",
      });
      expect(first.git?.recovery?.commit).toBe(first.git?.lastCommit);
      // Simulate a streaming file-change notification after Pi has created its lazy file.
      // The actual runner must schedule a mirror of that file,
      runner.getPiProcess()!.emit("agent_start");
      // not upload RPC frames as if they were session entries.
      const sessionFile = runner.getPiProcess()!.getSessionFile()!;
      fs.appendFileSync(
        sessionFile,
        `${JSON.stringify({ type: "custom", id: "streaming-marker", customType: "test", data: {} })}\n`,
      );
      runner
        .getPiProcess()!
        .emit("event", { type: "message_update", marker: "not-a-session-record" });
      await expect
        .poll(async () => await transcript(), { timeout: 7000 })
        .toContain("streaming-marker");
      expect(await transcript()).not.toContain("not-a-session-record");
      runner.getPiProcess()!.emit("agent_settled");
      await expect.poll(async () => (await manifest()).status).toBe("idle");
      expect(describeResult(first.status, finalAssistantMessage(await transcript()))).toBe(
        "settled",
      );
      expect(() =>
        git(remote, "show-ref", "--verify", "refs/heads/pi-cloud/run-round-trip"),
      ).toThrow();
      expect((await status()).suggestedAction).toBe("suspend");
      expect((await status()).agentState).toBe("idle");
      // A second real Pi turn is read-only: the scripted provider sees the prior tool result.
      const entriesBefore = (await transcript()).split("\n").length;
      await prompt("Report again without changing files");
      await expect
        .poll(async () => (await transcript()).split("\n").length)
        .toBeGreaterThan(entriesBefore);
      expect((await manifest()).git?.lastCommit).toBe(first.git?.lastCommit);
      expect(finalAssistantMessage(await transcript())?.complete).toBe(true);
      expect(runner.getPiProcess()!.getState()).toBe("running");
      mirror = new AbortController();
      const stream = await fetch(`${url}/v1/events`, { signal: mirror.signal });
      expect(stream.status).toBe(200);
      expect((await status()).attachedClientsCount).toBeGreaterThan(0);
      expect((await status()).suggestedAction).toBe("none");
      mirror.abort();
      await expect.poll(async () => (await status()).attachedClientsCount).toBe(0);
      expect((await status()).suggestedAction).toBe("suspend");
    } finally {
      mirror?.abort();
      await runner.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 40000);
});
