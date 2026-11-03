# Conversation transport

1. Keep the human-facing conversation as the shared surface. Use one persistent Claude Code session for the other participant, with the existing `claude-companion.sh` wrapper. Start with `ask --new`; subsequently use `ask --session <id>`. The wrapper runs `claude -p --output-format json` and resumes the session, so Claude retains its own context.
2. Supply the agreed public conversation context and the conversation guidelines in SKILL.md on entry. Select enough context to continue the conversation; a complete archive is not required. Keep authorship explicit; private transcripts remain outside this repository.
3. On subsequent turns, send only the new contributions, attributed to their speakers. Relay the human's words verbatim rather than replacing them with the calling model's interpretation. The calling model's own contribution is separately attributed. Either model can address the other, redirect, or pass; neither must answer every message.
4. Present Claude's complete reply, labelled as Claude, on the shared surface. Remove the wrapper's session/continuation metadata from the displayed contribution, but retain the session ID privately for resumption. Do not selectively excerpt, silently rewrite, or routinely append the calling model's verdict. Transport still depends on the calling agent making each call and displaying its result; there is no independent wake-up or simultaneous delivery.
5. Use `--tools none` for conversation with supplied context. Repository reading, if needed and authorised, is a separate choice. Ordinary conversation does not require implementation, review or debate workflows merely because two models participate.

With the companion script path in `COMPANION` and a prepared prompt file, the call shape is:

```sh
"$COMPANION" ask --new --model fable \
  --tools none --cwd "$CONVERSATION_ROOT" \
  --prompt-file "$PROMPT_FILE"

"$COMPANION" ask --session "$SESSION_ID" \
  --model fable --tools none \
  --cwd "$CONVERSATION_ROOT" \
  --prompt-file "$PROMPT_FILE"
```

**Authentication:** this skill uses API-key authentication. Load the key privately into `ANTHROPIC_API_KEY`; do not place it in a prompt, command argument, transcript or tracked file. If your API key requires a workspace header, configure `ANTHROPIC_CUSTOM_HEADERS` with `anthropic-workspace-id: <workspace-id>`. Unset `CLAUDE_CODE_OAUTH_TOKEN` and point `CLAUDE_COMPANION_TOKEN_FILE` at a known nonexistent path so the wrapper cannot silently load its default OAuth token. Also unset inherited `CLAUDECODE` for this separate process. Do not fall back to subscription authentication when the API call fails.

**Dependencies and migration:** `claude-companion.sh` is a separately installed dependency, not included in Backstage. Set `COMPANION` to its executable path. The expected wrapper supports the commands above and needs Claude Code, zsh and Python 3. Provide private API credentials and authorised context, and verify the call on the target machine. If the wrapper is unavailable, report that dependency rather than assuming the public repository provides it. Resuming an old session additionally requires its local Claude Code session history; a new session can instead receive selected public context. No session IDs, credentials or personal transcripts belong in this harness repository.
