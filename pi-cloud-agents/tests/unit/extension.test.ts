import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerExtension from "../../extension/index.js";
import { CloudAgentActionEnum } from "../../extension/tools/cloud-agent.js";

function fakePi() {
  const tools = new Map<
    string,
    {
      parameters: unknown;
      renderResult: (result: unknown, ...rest: unknown[]) => { render: (w: number) => string[] };
    }
  >();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }
  >();
  const api = {
    registerTool: vi.fn((tool) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((name: string, options) => {
      commands.set(name, options);
    }),
    on: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerShortcut: vi.fn(),
  };
  return { api, tools, commands };
}

describe("Extension registration", () => {
  it("registers the cloud_agent tool with its assignment actions", () => {
    const { api, tools } = fakePi();
    registerExtension(api as unknown as ExtensionAPI);

    expect([...tools.keys()]).toEqual(["cloud_agent"]);
    expect([...CloudAgentActionEnum]).toEqual(["launch", "status", "result", "steer", "stop"]);
    const params = tools.get("cloud_agent")?.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(params.properties)).toEqual(
      expect.arrayContaining(["action", "prompt", "runId", "autoPush", "wait", "timeoutSeconds"]),
    );
  });

  it("qualifies the rendered launch summary when prompt dispatch is unconfirmed", () => {
    const { api, tools } = fakePi();
    registerExtension(api as unknown as ExtensionAPI);
    const render = (promptDispatched: boolean) =>
      tools
        .get("cloud_agent")
        ?.renderResult({
          details: { action: "launch", runId: "run-20260906-abc", branch: "b", promptDispatched },
        })
        .render(200)
        .join("");

    expect(render(false)).toContain("prompt dispatch unconfirmed");
    expect(render(true)).not.toContain("unconfirmed");
  });

  it("registers /cloud run controls without mirror hooks, renderers or input interception", () => {
    const { api, commands } = fakePi();
    registerExtension(api as unknown as ExtensionAPI);

    expect([...commands.keys()]).toEqual(["cloud"]);
    expect(commands.get("cloud")?.description).toContain("suspend");
    expect(api.on).not.toHaveBeenCalled();
    expect(api.registerMessageRenderer).not.toHaveBeenCalled();
    expect(api.registerShortcut).not.toHaveBeenCalled();
  });

  it("routes the /cloud handler to the help catalog", async () => {
    const { api, commands } = fakePi();
    registerExtension(api as unknown as ExtensionAPI);

    const notify = vi.fn();
    const setStatus = vi.fn();
    await commands.get("cloud")?.handler("help", { hasUI: true, ui: { notify, setStatus } });
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("/cloud resume"), "info");
    expect(setStatus).not.toHaveBeenCalled();
  });
});
