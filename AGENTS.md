# Working on Backstage

Read [PLAN.md](PLAN.md) for purpose and [SETUP.md](SETUP.md) for the installed components and known limitations. Use [code-quality](skills/code-quality/SKILL.md) for implementation and review, and [writing](skills/writing/SKILL.md) for prose.

Hold the requested outcome stable; let evidence change the plan. Before adding machinery, name the accepted requirement and the demonstrated gap in the existing approach. Follow callers and ownership before introducing another special case. Verify the requested behaviour, not only the existing tests.

Keep documentation consolidated around current state. Distinguish implementation, installation and verification. Preserve unrelated changes and follow the user's Git permissions. Do not add secrets, personal conversations or employer material. Preserve upstream licences when modifying vendored code or patches.

## Test isolation

Tests must not reach a live tmux workspace or overwrite user configuration. Give each disposable tmux server an explicit `-L` or `-S` socket, unset `TMUX` and `TMUX_PANE`, and ensure every command targets that socket. Code that invokes bare `tmux` needs a wrapper selecting the test server. Never run `kill-server` without an explicit test socket.

Use temporary HOME, XDG and ccmux state directories and a separate daemon port for ccmux tests. Review third-party test setup before running it. Do not install packages, restart user services or deploy cloud resources as a side effect of ordinary tests.
