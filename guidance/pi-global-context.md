# Shared instructions

Read `$HOME/AGENTS.md` before acting unless its contents are already supplied in this session’s context. This is the shared global guidance, including Git permissions; it applies even when the working directory is outside the home directory, such as a temporary worktree. Resolve `$HOME` from the environment. Keep the current project’s local instructions as well.

## Tools

A tool declared in your tool list is callable as it is: call it directly. Under the Claude bridge, MCP servers' tools appear as `mcp__custom-tools__mcp__<server>__<tool>` (for example `mcp__custom-tools__mcp__linear__save_issue`). Use `tool_search` only for a server whose tools are not declared; finding a tool through it does not replace calling it. Do not ask for an API key or fall back to another route while the declared tool is available.
