import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiUiContext } from "./prompter-pi.js";
import { CLOUD_SUBCOMMANDS, getCloudArgumentCompletions, routeCloudCommand } from "./router.js";
import { registerCloudAgentTool } from "./tools/cloud-agent.js";

/**
 * Registers the `cloud_agent` assignment tool and the `/cloud` run controls.
 * Setup, configuration and deployment use the standalone `pi-cloud-agents` CLI.
 */
export default function (pi: ExtensionAPI): void {
  registerCloudAgentTool(pi);

  pi.registerCommand("cloud", {
    description: `Cloud agent run controls (${CLOUD_SUBCOMMANDS.map((cmd) => cmd.name).join(", ")})`,
    getArgumentCompletions: (prefix: string) => getCloudArgumentCompletions(prefix, []),
    handler: async (args: string, ctx) => {
      await routeCloudCommand(args, ctx as unknown as PiUiContext);
    },
  });
}
