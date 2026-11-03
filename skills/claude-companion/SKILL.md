---
name: claude-companion
description: Ask Claude Code from another agent and resume the same Claude session, using a local command wrapper. Use when asked to get Claude's input or continue a Claude conversation. Provides transport; use code-quality for reviews or three-way-conversation for informal conversations.
---

# Claude companion

Use [scripts/claude-companion.sh](scripts/claude-companion.sh) to call Claude Code and retain its session context. Requires `claude`, zsh and Python 3 on PATH. This skill supplies transport, not a mandatory debate or review protocol. Use [three-way-conversation](../three-way-conversation/SKILL.md) for informal conversations and [code-quality](../code-quality/SKILL.md) for code reviews.

Set `COMPANION` to the script's absolute path. Start a session with:

```sh
"$COMPANION" ask --new --tools none \
  --cwd "$CONVERSATION_ROOT" \
  --prompt-file "$PROMPT_FILE"
```

The reply ends with a session ID. Retain it privately and send only new contributions when continuing:

```sh
"$COMPANION" ask --session "$SESSION_ID" \
  --tools none --cwd "$CONVERSATION_ROOT" \
  --prompt-file "$PROMPT_FILE"
```

The default model is `fable`, overriding Claude's user settings even when resuming. Choose another available model with `--model` or `CLAUDE_COMPANION_MODEL`.

## Tools and execution

- `--tools none`: supplied context only, appropriate for conversation.
- `--tools ro` (default): Read, Grep and Glob. Set `--cwd` deliberately and use `--add-dir` only for authorised additional directories.
- `--tools all`: Claude's default tools with `dontAsk` permissions. Use only when the task authorises those actions; a directory argument is not a sandbox.
- `--background` returns a job identifier. Read it with `status <job>` and `result <job>`. `status <job> --wait --timeout <seconds>` waits for completion; completion alone does not establish success, so read the result.

Background jobs write under `CLAUDE_COMPANION_STATE`, defaulting to `~/.claude-companion/jobs`. Foreground calls do not write wrapper job files, but Claude Code may save its own session history. Keep job files, transcripts and session IDs outside tracked repositories. Resuming a session on another machine requires its Claude Code history; otherwise start a new session with selected context.

## Authentication

Use the account and credential type authorised for the task. The wrapper inherits Claude's authentication and can load `CLAUDE_CODE_OAUTH_TOKEN` from `CLAUDE_COMPANION_TOKEN_FILE` (default `~/.claude-companion/token`) when that variable is absent. Keep any token file private with mode 600.

For API-only conversations, follow [the conversation transport's authentication instructions](../three-way-conversation/references/transport.md): provide `ANTHROPIC_API_KEY` privately, unset the OAuth token and disable the wrapper's token-file fallback. Do not substitute subscription authentication after an API failure. Never place credentials in a prompt or tracked file.

A sandboxed caller also needs network access and access to the intended authentication source. If a call fails, report the actual failure rather than changing accounts or pretending Claude replied.
