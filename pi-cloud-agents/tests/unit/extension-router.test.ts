import { describe, expect, it, vi } from "vitest";

const handled = (subcommand: string) =>
  vi.fn(async (args: string[]) => ({ subcommand, args, output: subcommand, handled: true }));

const handlers = vi.hoisted(() => ({}) as Record<string, ReturnType<typeof vi.fn>>);

vi.mock("../../extension/commands/controls.js", () => {
  handlers.stop = handled("stop");
  handlers.suspend = handled("suspend");
  handlers.resume = handled("resume");
  handlers.logs = handled("logs");
  handlers.pr = handled("pr");
  return {
    handleCloudStopCommand: handlers.stop,
    handleCloudSuspendCommand: handlers.suspend,
    handleCloudResumeCommand: handlers.resume,
    handleCloudLogsCommand: handlers.logs,
    handleCloudPrCommand: handlers.pr,
  };
});
vi.mock("../../extension/commands/list.js", () => {
  handlers.list = handled("list");
  return { handleCloudListCommand: handlers.list };
});
vi.mock("../../extension/commands/status.js", () => {
  handlers.status = handled("status");
  return { handleCloudStatusCommand: handlers.status };
});

const { CLOUD_SUBCOMMANDS, formatHelpCatalog, getCloudArgumentCompletions, routeCloudCommand } =
  await import("../../extension/router.js");

const RUN_CONTROLS = ["list", "status", "stop", "suspend", "resume", "logs", "pr"];

describe("Extension router", () => {
  it("exposes only the retained run controls and help", () => {
    expect(CLOUD_SUBCOMMANDS.map((c) => c.name).sort()).toEqual([...RUN_CONTROLS, "help"].sort());
  });

  it.each(RUN_CONTROLS)("routes /cloud %s to its control handler with arguments", async (name) => {
    const res = await routeCloudCommand(`${name} 7f3a2c --yes`);
    expect(res.subcommand).toBe(name);
    expect(handlers[name]).toHaveBeenCalledWith(["7f3a2c", "--yes"], undefined);
  });

  it("renders help for an empty argument and /cloud help", async () => {
    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { notify } };

    const emptyRes = await routeCloudCommand("", ctx);
    expect(emptyRes.subcommand).toBe("help");
    expect(emptyRes.output).toContain("Command Catalog");

    const helpRes = await routeCloudCommand("help", ctx);
    expect(helpRes.output).toContain("/cloud suspend");
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it.each([
    "attach",
    "continue",
    "dashboard",
    "setup",
    "shell",
    "abort",
    "constructor",
    "__proto__",
  ])("treats removed or prototype names such as '%s' as unknown commands", async (name) => {
    const notify = vi.fn();
    const res = await routeCloudCommand(name, { hasUI: true, ui: { notify } });
    expect(res.handled).toBe(false);
    expect(res.output).toContain(`Unknown cloud command: '/cloud ${name}'`);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Unknown cloud command"), "error");
  });

  it("autocompletes retained subcommand names and active run IDs", () => {
    const sNames = getCloudArgumentCompletions("s")?.map((m) => m.value);
    expect(sNames).toEqual(["status", "stop", "suspend"]);

    const runMatches = getCloudArgumentCompletions("status run-", ["run-1234", "run-5678"]);
    expect(runMatches?.map((m) => m.value)).toEqual(["status run-1234", "status run-5678"]);

    expect(getCloudArgumentCompletions("xyz12345")).toBeNull();
  });

  it("formats the help catalog without emoji and points to the tool and CLI", () => {
    const catalog = formatHelpCatalog();
    expect(catalog).toContain("┌ pi cloud agents · Command Catalog");
    expect(catalog).toContain("cloud_agent tool");
    expect(catalog).toContain("pi-cloud-agents CLI");
    expect(catalog).not.toMatch(/[\u{1F000}-\u{1FAFF}]/u);
    for (const line of catalog.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});
