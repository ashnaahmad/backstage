/**
 * Command router and completion engine for `/cloud <sub> [args]`.
 */

import {
  handleCloudLogsCommand,
  handleCloudPrCommand,
  handleCloudResumeCommand,
  handleCloudStopCommand,
  handleCloudSuspendCommand,
} from "./commands/controls.js";
import { handleCloudListCommand } from "./commands/list.js";
import { handleCloudStatusCommand } from "./commands/status.js";
import type { PiUiContext } from "./prompter-pi.js";

export interface SubcommandDefinition {
  name: string;
  description: string;
  usage: string;
  takesRunId?: boolean;
}

export const CLOUD_SUBCOMMANDS: SubcommandDefinition[] = [
  { name: "list", description: "List active and recent cloud agent runs", usage: "/cloud list" },
  {
    name: "status",
    description: "Show detail card and live telemetry for a run",
    usage: "/cloud status <runId>",
    takesRunId: true,
  },
  {
    name: "stop",
    description: "Terminate a running cloud agent VM",
    usage: "/cloud stop <runId>",
    takesRunId: true,
  },
  {
    name: "suspend",
    description: "Suspend a running cloud agent VM",
    usage: "/cloud suspend <runId>",
    takesRunId: true,
  },
  {
    name: "resume",
    description: "Resume a suspended cloud agent VM",
    usage: "/cloud resume <runId>",
    takesRunId: true,
  },
  {
    name: "logs",
    description: "View or tail CloudWatch logs for a run",
    usage: "/cloud logs <runId> [--follow]",
    takesRunId: true,
  },
  {
    name: "pr",
    description: "Create GitHub pull request from run work branch",
    usage: "/cloud pr <runId> [title]",
    takesRunId: true,
  },
  { name: "help", description: "Show cloud agent command catalog", usage: "/cloud help" },
];

export interface AutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

/**
 * Returns autocompletion suggestions for `/cloud ...` commands.
 */
export function getCloudArgumentCompletions(
  prefix: string,
  activeRunIds: string[] = [],
): AutocompleteItem[] | null {
  const trimmed = prefix.trimStart();
  const parts = trimmed.split(/\s+/);

  if (parts.length <= 1 && !prefix.endsWith(" ")) {
    // Autocomplete subcommand name
    const query = parts[0] || "";
    const matches = CLOUD_SUBCOMMANDS.filter((cmd) => cmd.name.startsWith(query));
    if (matches.length === 0) return null;
    return matches.map((cmd) => ({
      value: cmd.name,
      label: cmd.name,
      description: cmd.description,
    }));
  }

  const sub = parts[0]?.toLowerCase();
  const subDef = CLOUD_SUBCOMMANDS.find((cmd) => cmd.name === sub);

  if (subDef?.takesRunId) {
    const runArg = parts[1] || "";
    const matchingRuns = activeRunIds.filter((id) => id.startsWith(runArg));
    if (matchingRuns.length > 0) {
      return matchingRuns.map((id) => ({
        value: `${sub} ${id}`,
        label: id,
        description: `Active run ${id}`,
      }));
    }
  }

  return null;
}

/**
 * Formats the `/cloud help` command catalog table.
 */
export function formatHelpCatalog(): string {
  const width = 76;
  const innerWidth = width - 4;
  const lines: string[] = [];
  const headerTitle = " pi cloud agents · Command Catalog ";
  const topDashes = Math.max(0, width - 2 - headerTitle.length);

  lines.push(`┌${headerTitle}${"─".repeat(topDashes)}┐`);
  lines.push(`│ ${"Command".padEnd(20)} ${"Description".padEnd(innerWidth - 21)} │`);
  lines.push(`├${"─".repeat(width - 2)}┤`);

  for (const cmd of CLOUD_SUBCOMMANDS) {
    const namePart = `/cloud ${cmd.name}`.padEnd(20);
    const descPart = cmd.description.slice(0, innerWidth - 21);
    const line = `│ ${namePart} ${descPart.padEnd(innerWidth - 21)} │`;
    lines.push(line);
  }

  lines.push(`├${"─".repeat(width - 2)}┤`);
  lines.push(`│ ${"Usage: /cloud <command> [args]".padEnd(innerWidth)} │`);
  lines.push(
    `│ ${"Launch and results: cloud_agent tool. Setup: pi-cloud-agents CLI".padEnd(innerWidth)} │`,
  );
  lines.push(`└${"─".repeat(width - 2)}┘`);

  return lines.join("\n");
}

export type RouteContext = PiUiContext;

export interface RouteResult {
  subcommand: string;
  args: string[];
  output: string;
  handled: boolean;
}

/**
 * Routes `/cloud <sub> [args]` command execution.
 */
type SubcommandHandler = (subArgs: string[], ctx?: RouteContext) => Promise<RouteResult>;

const HANDLERS = new Map<string, SubcommandHandler>([
  ["list", handleCloudListCommand],
  ["status", handleCloudStatusCommand],
  ["stop", handleCloudStopCommand],
  ["suspend", handleCloudSuspendCommand],
  ["resume", handleCloudResumeCommand],
  ["logs", handleCloudLogsCommand],
  ["pr", handleCloudPrCommand],
]);

/**
 * Routes `/cloud <sub> [args]` command execution. Assignments are launched and retrieved
 * through the `cloud_agent` tool; setup, configuration and deployment use the standalone CLI.
 */
export async function routeCloudCommand(rawArgs: string, ctx?: RouteContext): Promise<RouteResult> {
  const trimmed = rawArgs.trim();
  const parts = trimmed.length > 0 ? trimmed.split(/\s+/) : [];
  const sub = (parts[0] || "help").toLowerCase();
  const subArgs = parts.slice(1);

  if (sub === "help") {
    const helpText = formatHelpCatalog();
    if (ctx?.hasUI && ctx.ui?.notify) {
      ctx.ui.notify(helpText, "info");
    }
    return { subcommand: "help", args: subArgs, output: helpText, handled: true };
  }

  const handler = HANDLERS.get(sub);
  if (handler) {
    return handler(subArgs, ctx);
  }

  const unknownNotice = `Unknown cloud command: '/cloud ${sub}'. Run '/cloud help' to see available commands.`;
  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(unknownNotice, "error");
  }
  return { subcommand: sub, args: subArgs, output: unknownNotice, handled: false };
}
