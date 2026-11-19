import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../cli/main.js";
import { formatConfigView, getConfigValue, setConfigValue } from "../../core/config-editor.js";
import { loadLocalConfig, saveLocalConfig } from "../../core/config.js";
import { DEFAULT_LOCAL_CONFIG, type LocalConfig } from "../../shared/config.js";

describe("T4.11 Config Editor & pi-cloud-agents config", () => {
  let tempDir: string;
  let prevAgentDir: string | undefined;

  beforeEach(() => {
    prevAgentDir = process.env.PI_AGENT_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-cloud-config-test-"));
    process.env.PI_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    process.env.PI_AGENT_DIR = prevAgentDir;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe("getConfigValue", () => {
    it("reads top-level and nested configuration properties correctly", () => {
      const config: LocalConfig = {
        ...DEFAULT_LOCAL_CONFIG,
        aws: { region: "us-west-2", profile: "work" },
        defaults: {
          ...DEFAULT_LOCAL_CONFIG.defaults,
          maxDurationHours: 6,
          idle: { suspendAfterMin: 20, terminateAfterSuspendedMin: 60 },
        },
        providers: {
          synced: ["anthropic", "openai"],
          oauthOptIn: ["anthropic"],
          bedrockRole: true,
        },
      };

      expect(getConfigValue(config, "aws.region")).toBe("us-west-2");
      expect(getConfigValue(config, "aws.profile")).toBe("work");
      expect(getConfigValue(config, "defaults.maxDurationHours")).toBe(6);
      expect(getConfigValue(config, "defaults.idle.suspendAfterMin")).toBe(20);
      expect(getConfigValue(config, "providers.synced")).toEqual(["anthropic", "openai"]);
      expect(getConfigValue(config, "providers.bedrockRole")).toBe(true);
      expect(getConfigValue(config, "non.existent.key")).toBeUndefined();
    });
  });

  it("persists the no-push policy through the supported CLI config command", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runCli(["node", "main.js", "config", "defaults.autoPush", "false"])).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(loadLocalConfig({ customDir: tempDir }).defaults.autoPush).toBe(false);
  });

  describe("setConfigValue & Validation", () => {
    it("updates numeric fields with bounds enforcement", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const res = setConfigValue(config, "defaults.maxDurationHours", "6");
      expect(res.newValue).toBe(6);
      expect(res.config.defaults.maxDurationHours).toBe(6);

      // Exceeds 8h hard max
      expect(() => setConfigValue(config, "defaults.maxDurationHours", "12")).toThrow(
        /exceeds maximum allowed/,
      );

      // Below 1h min
      expect(() => setConfigValue(config, "defaults.maxDurationHours", "0")).toThrow(
        /below minimum allowed/,
      );

      // Invalid number
      expect(() => setConfigValue(config, "defaults.maxDurationHours", "not-a-number")).toThrow(
        /Invalid number/,
      );
    });

    it("updates boolean fields from various truthy/falsy representations", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      expect(setConfigValue(config, "defaults.autoPush", "true").newValue).toBe(true);
      expect(setConfigValue(config, "defaults.autoPush", "false").newValue).toBe(false);
      expect(setConfigValue(config, "defaults.autoPush", "1").newValue).toBe(true);
      expect(setConfigValue(config, "defaults.autoPush", "0").newValue).toBe(false);
      expect(setConfigValue(config, "defaults.autoPush", "yes").newValue).toBe(true);
      expect(setConfigValue(config, "defaults.autoPush", "no").newValue).toBe(false);

      expect(() => setConfigValue(config, "defaults.autoPush", "maybe")).toThrow(
        /Invalid boolean value/,
      );
    });

    it("updates array fields from comma-separated strings or arrays", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const res1 = setConfigValue(config, "providers.synced", "anthropic, openai, bedrock");
      expect(res1.newValue).toEqual(["anthropic", "openai", "bedrock"]);
      expect(res1.config.providers.synced).toEqual(["anthropic", "openai", "bedrock"]);

      const res2 = setConfigValue(config, "providers.synced", ["gemini", "groq"]);
      expect(res2.newValue).toEqual(["gemini", "groq"]);
    });

    it("validates supported AWS regions and throws on unsupported regions", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const res = setConfigValue(config, "aws.region", "us-east-2");
      expect(res.newValue).toBe("us-east-2");
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain("Region changed to 'us-east-2'");

      expect(() => setConfigValue(config, "aws.region", "af-south-1")).toThrow(
        /Unsupported AWS region/,
      );
    });

    it("produces appropriate migration warnings on critical configuration changes", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };

      const memRes = setConfigValue(config, "image.memoryMiB", "8192");
      expect(memRes.warnings).toHaveLength(1);
      expect(memRes.warnings[0]).toContain(
        "Run 'pi-cloud-agents update' to rebuild the runner image",
      );

      const provRes = setConfigValue(config, "providers.synced", "anthropic");
      expect(provRes.warnings).toHaveLength(1);
      expect(provRes.warnings[0]).toContain("Run 'pi-cloud-agents sync'");

      const profRes = setConfigValue(config, "aws.profile", "dev-account");
      expect(profRes.warnings).toHaveLength(1);
      expect(profRes.warnings[0]).toContain("AWS profile changed");
    });
  });

  describe("formatConfigView", () => {
    it("formats a width-safe table without forbidden emojis", () => {
      const config = { ...DEFAULT_LOCAL_CONFIG };
      const output = formatConfigView(config, 80);

      expect(output).toContain("pi cloud agents · Configuration");
      expect(output).toContain("[AWS]");
      expect(output).toContain("[Defaults]");
      expect(output).toContain("aws.region");
      expect(output).toContain("us-east-1");

      const lines = output.split("\n");
      for (const line of lines) {
        expect(line.length).toBeLessThanOrEqual(80);
      }
    });
  });

  describe("CLI config command", () => {
    async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
      const out: string[] = [];
      const err: string[] = [];
      const log = vi.spyOn(console, "log").mockImplementation((msg) => out.push(String(msg)));
      const error = vi.spyOn(console, "error").mockImplementation((msg) => err.push(String(msg)));
      try {
        const code = await runCli(["node", "main.js", "config", ...args]);
        return { code, out: out.join("\n"), err: err.join("\n") };
      } finally {
        log.mockRestore();
        error.mockRestore();
      }
    }

    it("returns the full table view without arguments", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);
      const res = await cli([]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("pi cloud agents · Configuration");
    });

    it("reads a specific field value", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);
      const res = await cli(["defaults.maxDurationHours"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("defaults.maxDurationHours = 4");
    });

    it("updates and saves a field", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);
      const res = await cli(["defaults.maxDurationHours", "7"]);
      expect(res.code).toBe(0);
      expect(res.out).toContain("Updated 'defaults.maxDurationHours' from 4 to 7.");
      expect(loadLocalConfig().defaults.maxDurationHours).toBe(7);
    });

    it("rejects unknown keys and out-of-range values without saving", async () => {
      saveLocalConfig(DEFAULT_LOCAL_CONFIG);
      const unknown = await cli(["unknown.key", "1"]);
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain("Unknown configuration key 'unknown.key'");

      const tooLong = await cli(["defaults.maxDurationHours", "99"]);
      expect(tooLong.code).toBe(1);
      expect(tooLong.err).toContain("exceeds maximum allowed");
      expect(loadLocalConfig().defaults.maxDurationHours).toBe(4);
    });
  });
});
