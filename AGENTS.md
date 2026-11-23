# Working on Backstage

Read [PLAN.md](PLAN.md) for purpose and [SETUP.md](SETUP.md) for the installed components and known limitations. Use [code-quality](skills/code-quality/SKILL.md) for implementation and review, and [writing](skills/writing/SKILL.md) for prose.

Hold the requested outcome stable; let evidence change the plan. Before adding machinery, name the accepted requirement and the demonstrated gap in the existing approach. Follow callers and ownership before introducing another special case. Verify the requested behaviour, not only the existing tests.

Keep documentation consolidated around current state. Distinguish implementation, installation and verification. Preserve unrelated changes and follow the user's Git permissions. Do not add secrets, personal conversations or employer material. Preserve upstream licences when modifying vendored code or patches.

## Delegated Pi sessions

Default roles: Astra (`openai/gpt-6.2-astra`) coordinates, Opus 5.5 (`claude-bridge/claude-opus-5-5`) implements, Sol (`openai/gpt-6.2-sol`) reviews independently through code-quality, and live-app QA runs in a separate session. Verify the session model before dispatching `/implement`.

## Test isolation

Tests must not reach a live tmux workspace or overwrite user configuration. Give each disposable tmux server an explicit `-L` or `-S` socket, unset `TMUX` and `TMUX_PANE`, and ensure every command targets that socket. Code that invokes bare `tmux` needs a wrapper selecting the test server. Never run `kill-server` without an explicit test socket.

Use temporary HOME, XDG and ccmux state directories and a separate daemon port for ccmux tests. Review third-party test setup before running it. Do not install packages, restart user services or deploy cloud resources as a side effect of ordinary tests.

## Session snapshots

For Pi coordination, use `scripts/session-snapshot.mjs <session-id|%pane>` to distinguish an older reply from newer user messages and ccmux-reported activity. Its verdict concerns persisted history, not task fulfilment; see [SETUP.md](SETUP.md#session-snapshot) for usage and limits.

For assignments adopted into the coordination record, use `scripts/coordination-record.mjs` to update roles and evidence and generate maps/handoffs. Keep the record outside repositories; the brief remains the requirements authority. See [SETUP.md](SETUP.md#coordination-record). Do not migrate an active assignment without coordinating its existing authority.

For brief restoration, record the implementing Pi session’s native id and launch it with the record; see [restoring the current brief](SETUP.md#restoring-the-current-brief). Codex agents read `brief <id>` at the same transitions and before handoff. Later corrections in the conversation take precedence over the restored brief.

Codex orchestrators can opt in to the [Codex stop gate](SETUP.md#codex-stop-gate): enroll as the accountable record actor and watch each assignment after sending work. Record the outcome after following through; pause or resume explicitly. Installing the hooks enrolls no session, and they run only after the user trusts them in Codex.
