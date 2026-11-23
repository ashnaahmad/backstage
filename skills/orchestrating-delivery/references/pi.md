# Coordinating from Pi

Read when the coordinator, or a delegate reporting to it, runs in Pi.

## Launching

Start each delegate as interactive Pi in a named tmux window at its own checkout, with its role's model passed explicitly: Astra `openai/gpt-6.2-astra`, Opus 5.5 `claude-bridge/claude-opus-5-5`, Sol `openai/gpt-6.2-sol`. Claude models go through the bridge, never `anthropic/...`. Confirm the session's model before dispatching `/implement` or `/browser-verify`. Keep long briefs in a file outside the repository and send a pointer.

## Messaging

- **Pi to Pi, both ways:** `ccmux send --stdin <session>`, labelled with the sender. The message starts a turn in the recipient, so a delegate reports to its Pi owner, handoff included, by messaging it. Nobody polls.
- **Pi to a Codex owner:** ccmux cannot reach a Codex chat. Use [handoff submission](../../writing-handoffs/SKILL.md#submitting-to-a-codex-owner) with the owner's thread id from the brief.
- Find sessions with `ccmux show --json`. Before sending, check the recipient has no unsent draft (`ccmux screen <session>`).

## Waiting

Wait for a session, process or review with Pi's `wait` tool, with a check command if needed, never `sleep` or a polling loop in the shell. Messages from the user and other sessions arrive only between tool calls: a blocking shell command holds them back and can merge an incoming message into the user's unsent draft.

A message to a Pi session starts a new turn there, so the owner of a delegate never needs to poll it.

## Coordination record

Where the harness [coordination record](../../../SETUP.md#coordination-record) is in use, it holds each assignment's roles, dependencies, blocker and evidence references. Record a delegate's native session id as implementer and launch it with the record so it [restores its current brief](../../../SETUP.md#restoring-the-current-brief) at transitions.

## Guards

Declare the coordinator with `/delivery coordinator <record> <actor>` and the relay with `/delivery relay <record> <actor>` ([delivery guards](../../../SETUP.md#delivery-guards)). The coordinator then gets a landing-map reminder after each incoming message, a stall check after each record write, an announcement when a delegate goes quiet, and a readiness check on `gh pr merge`, on `--stage merge-ready` and on replies that call a PR merge-ready. The relay's review-request posts are checked against the map and their permalinks recorded; a coordinator's are refused, since the relay owns them. In both roles, long sleeps and watch loops in bash are blocked in favour of `wait`.
