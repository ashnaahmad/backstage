# Portable setup

Global Pi setup, assessed on 26 October 2026. A fresh-computer/account rehearsal remains outstanding. See [migration requirements](REQUIREMENTS.md) for external dependencies, observed versions and optional features.

## Restore the workspace

Clone `https://github.com/ashnaahmad/backstage.git` into a dedicated directory and run these commands from its root. Install Git, Python 3 for the probes, and Node.js >=22.19.0 with npm. The current machine uses Node 25.3.0, Pi 1.4.0 and Claude Code 2.1.304.

```sh
npm install -g @earendil-works/pi-coding-agent@1.4.0
```

Install Claude Code using its supported installer and sign in with the account intended for the new computer. Claude login is separate from Pi's GPT login. Run Pi in this checkout and use its login flow for the intended ChatGPT subscription. Verify available models and account entitlements for your accounts; the sample model selection is configurable.

Install the pinned packages globally (omit `-l`):

```sh
pi install npm:pi-claude-bridge@0.9.3
pi install npm:@tmustier/pi-files-widget@0.2.1
pi install npm:pi-studio@0.11.1
pi install npm:pi-markdown-preview@0.24.0
pi install npm:pi-secrets@0.1.1
brew install bat git-delta glow pandoc hunk neovim
scripts/install-markdown-editor.sh
```

Install Chrome or another renderer-supported Chromium browser for image previews. PDF/LaTeX and Studio's optional Quarto/REPL dependencies are outside the current setup. Restart Pi or `/reload`; accept project trust only after reviewing the checkout.

In `~/.pi/agent/settings.json`, preserve unrelated settings and add the absolute paths of this checkout's `pi/extensions/code-quality.ts`, `pi/extensions/quality-feedback.ts`, `pi/extensions/diff-pane.ts`, `pi/extensions/idle-exit.ts` and `pi/extensions/wait.ts` to `extensions`, and the directory `skills` to `skills`. Copy the `defaultProvider`, `defaultModel` and `enabledModels` values from [.pi/settings.json](.pi/settings.json). Merge [.pi/claude-bridge.json](.pi/claude-bridge.json) into the global file of the same name. Recompute these paths after moving the checkout. `pi/extensions/` and `skills/` are deliberately not directories Pi discovers on its own: the harness loads once, from this main checkout, in every directory, including other worktrees of this branch (see [testing in a worktree](#testing-harness-changes-in-a-worktree)). Its local npm pins match the global ones.

If migrating an existing agent setup, reconcile its quality hooks and skills with this bundle so the same guidance does not load twice. Back up settings before removing registrations.

Claude Code supports repository `AGENTS.md` directly from v2.1.277. No root `CLAUDE.md` pointer is needed here. Native Claude Code defaults to `CLAUDE.md` instead if one (or `CLAUDE.local.md`) exists in the working directory or an ancestor; check its Project instructions setting in that case. In Pi, the bridge uses Pi-supplied context and excludes native project instruction loading to avoid duplicates. See [Claude Code memory documentation](https://code.claude.com/docs/en/memory#agentsmd).

## Private credential entry

[pi-secrets](https://github.com/liamvinberg/pi-secrets) provides
`request_secret`: a masked prompt outside the chat composer.
Commands receive the value through a named environment variable;
the tool reports only its name and length. `/secrets` lists or
clears held values. Captured secrets live in the Pi process, not
in the portable configuration; enter them again after restarting.

A dummy-token probe on 30 October 2026 passed through Opus 5.5
and Claude bridge 0.9.3: the shell received the expected value,
raw/Base64/URL-encoded tool output was redacted, and none of those
values appeared in the saved Pi transcript. This is accidental
leak protection, not isolation from an agent with shell access.
Use narrowly scoped credentials. Store a credential in AWS only
when that destination and purpose are intended; this extension
itself is not an encrypted remote credential store.

## Mobile terminal

The Pi workspace in a phone browser, at a fixed private URL:
[ttyd](https://github.com/tsl0922/ttyd) on loopback port 7681,
run at login by a macOS LaunchAgent, and published to the tailnet
only through Tailscale Serve on HTTPS port 8443. It shows the
existing tmux session; it is not another Pi. Requires ttyd
(`brew install ttyd`; tested with 1.7.7), Tailscale on the Mac and
phone, and the [tab rows](tmux/pi-tabs.conf) installed. From this
checkout, `install` starts it now and at each login and adds the
Serve route; `status` shows the service and URL; `uninstall` stops
it and removes the LaunchAgent and this Serve route:

```sh
scripts/mobile-terminal.sh install
scripts/mobile-terminal.sh status
scripts/mobile-terminal.sh uninstall
```

`install` takes an optional session name (default `pi-workspace`)
and refuses while port 7681 is in use by something else, or while
Serve port 8443 has another route, a public Funnel, or a
configuration it cannot read. `uninstall` removes the Serve route
only when it is exactly this proxy. macOS refuses a LaunchAgent
access to `~/Documents` ("Operation not permitted"), so `install`
copies the files the service uses (this script,
`scripts/tmux-sidebar.sh`, `scripts/tmux-mobile-select.sh`,
`tmux/mobile.conf`, `mobile/page.js`)
to `~/.local/share/pi-mobile-terminal`, and the LaunchAgent
(`~/Library/LaunchAgents/local.pi-harness.mobile-terminal.plist`)
runs that copy. Rerun `install` from the checkout after changing
them; it replaces the copy only once the new plist is valid, and
`uninstall` deletes it. The LaunchAgent also records the installing
shell's `PATH` and the tmux server its `tmux` reaches. The service
keeps ttyd running and regenerates its page
at each start, writing it and `ttyd.log` to
`~/.local/state/pi-mobile-terminal`. It never starts tmux; without
the session, a connection closes at once. Each phone connection is
a tmux client with its own view of the session (the tab rows'
[view hook](scripts/tmux-view.sh)), which closes when the page
does. Anyone on the tailnet allowed to reach the Mac controls the
terminal; ttyd accepts one connection at a time.

The page is ttyd's own, with a viewport tag (pinch zoom still
works) and [a bar above the terminal](mobile/page.js):

- **Paste field:** iOS offers no Paste in the terminal itself.
  Hold the field to paste, then **Paste** sends one line to the
  active pane, as if typed, without Return, and clears the field.
  It is masked, for credentials such as a pi-secrets prompt;
  **Show** reveals ordinary text. Nothing is stored or sent
  elsewhere. The field holds one line, so pasted line breaks
  (which could act as Return) do not reach the terminal; control
  characters are refused.
- **Sidebar**, **−** and **+:** open or close the Sessions sidebar
  in the window shown, as Ctrl+Q does, and narrow or widen it by
  5 columns until it closes.
- **Focus:** shows only the active pane, or every pane again
  (tmux zoom). Tap a pane to make it active.
- **Sessions**, **Agent** and **Preview:** make the window's
  sidebar, Pi pane, or Markdown editor / diff pane the active
  one, keeping Focus, so with Focus on they switch between full
  screens. Repeated presses do not cycle documents, diffs or agent
  sessions: use the bottom Panels and Windows tabs to choose those.
  Nothing is opened; a missing pane is reported by tmux.
  Sidebar still opens or closes the sidebar itself.
- **Edit**, **Esc** and **Save:** start typing, stop typing and
  save in the Markdown editor pane. They act only when that
  editor is the active pane; otherwise tmux says to tap it first,
  and nothing is typed into Pi.

The buttons send key sequences that tmux maps to commands for the
page's own client, in the window it shows ([tmux/mobile.conf](tmux/mobile.conf),
sourced as each connection attaches). Windows and their layouts
are shared with the desktop: a sidebar, width or Focus change on
the phone appears on a desktop showing the same window. The
sidebar resize hook leaves a focused (zoomed) window alone, so
the phone keyboard opening does not undo Focus; `ccmux sidebar
--toggle` registers ccmux's own hook again, until the next
connection or sidebar button. On a phone-width window, closing the
sidebar gives its columns to the pane beside it, which can leave
another pane very narrow; Focus shows that pane at full width.

Tests: `node --test scripts/tests/mobile-terminal.test.mjs`
(disposable tmux servers; stub `launchctl` and `tailscale`). Checked
on 30 October 2026 in Chromium's iPhone 13 emulation against a
disposable workspace with the real pi-secrets prompt and Markdown
editor, and with a real LaunchAgent under a test label (started
by bootstrap, restarted by KeepAlive from its copy after the
source was deleted, removed by uninstall).
Earlier, the trial's masked field delivered a real token from an
iPhone. Not yet confirmed: the buttons, tapping a pane and the
keyboard staying open after a button press on the iPhone itself,
and the service starting at login after a real restart
(`RunAtLoad` is configured, not yet exercised).

## Skills

Pi loads every skill in this checkout's `skills/` through that global `skills` entry, from any directory; `skills/` is not discovered as project skills, so a worktree adds no second copy:

- [code-quality](skills/code-quality/SKILL.md): implementation, testing and review.
- [claude-companion](skills/claude-companion/SKILL.md): a bundled Claude Code wrapper for new and resumed sessions; requires Claude Code, zsh and Python 3.
- [three-way-conversation](skills/three-way-conversation/SKILL.md): informal conversations between the user and two assistants. Uses the bundled `claude-companion.sh`; requires Claude Code, zsh, Python 3 and private API credentials; see its [transport reference](skills/three-way-conversation/references/transport.md).
- [skill-creator](skills/skill-creator/SKILL.md): creating or revising skills for any workflow.
- [writing](skills/writing/SKILL.md): drafting and revising prose; it selects the [Claude](guidance/claude-writing.md) or [Astra](guidance/astra-writing.md) detailed guide by model family, only for relevant writing tasks.

Other clients can load these same skill directories using their own configuration. Check a new or changed skill with `/reload`, the startup resource list (Ctrl+O) and `/skill:name`.

Pi reads `~/.pi/agent/AGENTS.md` in every directory but the shared `~/AGENTS.md` only through a directory's ancestors, so a temporary worktree outside home would miss it. Link the tracked [entrypoint](guidance/pi-global-context.md), which tells the model to read `$HOME/AGENTS.md` unless it is already in context:

```sh
ln -s "$PWD/guidance/pi-global-context.md" ~/.pi/agent/AGENTS.md
```

### Testing harness changes in a worktree

Any directory, including a worktree of this branch, runs the extensions, skills and `/implement` installed from the main checkout. To run a worktree's own versions instead, start Pi from that worktree's root with extension, skill and prompt-template loading turned off and those pieces named explicitly, the provider bridge included:

```sh
B=~/.pi/agent/npm/node_modules/pi-claude-bridge
pi -ne -ns -np \
  -e "$B/src/index.ts" \
  -e pi/extensions/code-quality.ts \
  -e pi/extensions/quality-feedback.ts \
  -e pi/extensions/diff-pane.ts \
  -e pi/extensions/idle-exit.ts \
  -e pi/extensions/wait.ts \
  --skill skills --prompt-template pi/prompts
```

`-ne`, `-ns` and `-np` stop Pi loading discovered and configured extensions (package extensions included), skills and prompt templates, so neither the installed harness nor its global skills and `/implement` load; the explicit paths still do. Other settings, such as the model, themes and context files, still apply. A worktree created before `pi/extensions/` existed still has `.pi/extensions/`, `.agents/skills/` and `.pi/prompts/`, which Pi discovers on top of the installed copies and rejects as conflicting tools; start such a worktree with the command above (using its old paths) or rebase it onto the current branch.

## What travels in Git

- [Project settings](.pi/settings.json) pin packages and select models. [Bridge settings](.pi/claude-bridge.json) carry the provider configuration without credentials.
- [Code-quality skill](skills/code-quality/SKILL.md) and [quality extension](pi/extensions/code-quality.ts) are referenced by the global configuration. The [review transport](scripts/lib/quality-review.ts) uses the global bridge installation, including from other repositories.
- **Point-in-time document feedback:** [Pi event hook](pi/extensions/quality-feedback.ts), [detector](scripts/lib/quality-feedback.ts), [scope configuration](.pi/quality-checks.json) and [tests](scripts/tests/quality-feedback.test.mjs). These are tracked despite `.pi` being hidden in many file browsers. The hook adds advisory tool-result feedback; it does not rewrite or block edits. It flags newly introduced chronology markers in configured standing documents, not all possible stale prose. Current scope: PLAN.md, README.md, AGENTS.md and guidance/. Other repositories default to AGENTS.md, README.md and PLAN.md; their own `standingDocuments` list replaces that scope, and `[]` disables it.
- [AGENTS.md](AGENTS.md) governs work on this repository. [Global instructions](guidance/global-agents.md) are a portable template for cross-project guidance, not an automatically discovered filename. Reconcile them with `~/AGENTS.md`; the [Pi entrypoint](guidance/pi-global-context.md) tells Pi to read that file from any working directory. The writing skill separately selects its model-specific guide. Recreate shared skill symlinks against the new checkout; do not copy this Mac's absolute links.

The hook runs inside Pi for either model. It does nothing in repositories whose configuration sets `standingDocuments` to `[]`. It does not automatically run in an outer Codex or Claude session. The old Claude quality hook has been removed; Pi is the unified quality surface.

The default implementer is Opus 5.5 through `claude-bridge`;
`quality_review` selects Sol 6.1 for that provider. Existing
sessions can retain their selected model: switch with `/model`
or start a new session to use the new default.

## Check the restored setup

Local checks without model calls. Before running tmux or ccmux tests, use an isolated test server and temporary HOME, XDG and ccmux state, with TMUX and TMUX_PANE unset. Every tmux command must target the test socket; never let a test reach a live workspace:

```sh
node --test scripts/tests/*.test.mjs
```

The synthetic provider handoff uses both subscriptions:

```sh
python3 scripts/check-model-handoff.py
```

Then verify skill/context discovery, a real edit receiving document feedback, independent review, and the writing commands in [README](README.md#writing-surfaces). Inspect inherited ancestor/global instructions and Claude hooks: an old installation can silently add context absent from this checkout. Test Git authentication and pushing from the new computer separately.

On this Mac, the resource loader finds the harness skills once in the main harness checkout, another repository and a neutral directory. A harness worktree loads the same single copy; only a worktree created before `pi/extensions/` existed loads duplicates (see [testing in a worktree](#testing-harness-changes-in-a-worktree)). A synthetic Claude bridge request included the selected skill and excluded native instruction/rule/skill canaries. Claude settings still load, and unrelated hooks may run; this is not blanket isolation. AskClaude stays disabled. Recheck this boundary when changing the bridge version.

A fresh Claude session outside the harness discovered and read the global skill, updated quality status and successfully called Sol through `quality_review`. The reverse reviewer transport also returned the expected marker through the global Opus bridge. These synthetic checks verify discovery and transport, not a complete application implementation.

## Configuration outside this bundle

Configure account access, MCP connections and additional skills separately. Credentials, local caches and conversations are not bundled. Reinstall packages rather than copying `.pi/npm`.

## AWS cloud-agent experiment

The optional cloud experiment uses `eu-north-1`. Follow AWS's
[Agent Toolkit setup](https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/refs/heads/main/setup-instructions/setup.md),
with Pi as the only configured agent. Install the AWS CLI with AWS's
user-local installer rather than Homebrew (see [requirements](REQUIREMENTS.md#optional-features--install-only-when-used)),
then sign in through the browser and install the skills and MCP server:

```sh
curl -fsSL https://awscli.amazonaws.com/v2/install.sh -o /tmp/aws-install.sh
bash /tmp/aws-install.sh            # ~/.local/bin/aws; needs ~/.local/bin on PATH
aws configure set region eu-north-1 --profile backstage
aws login --region eu-north-1 --profile backstage
aws configure agent-toolkit --region us-east-1 --profile backstage   # select only Pi
pi mcp add aws-mcp --env AWS_MCP_PROXY_PROFILES=backstage -- \
  uvx mcp-proxy-for-aws-cli@latest https://aws-mcp.us-east-1.api.aws/mcp \
  --metadata AWS_REGION=eu-north-1
pi mcp list
```

The toolkit service runs only in `us-east-1`; the project's resources
stay in `eu-north-1`. If `aws login` cannot open a browser from a tmux
window, run it from a plain shell and open the printed URL with `open`.
Credentials last 12 hours and refresh for 90 days. The wizard installs
24 skills in `~/.pi/agent/skills`. Keep that AWS collection outside
Pi's automatic discovery, as on this machine: after installing the
toolkit, move its 24 skill directories into
`~/.pi/skill-collections/aws/`, preserving their relative structure
and leaving unrelated skills alone. Repeat this check after toolkit
updates, which may reinstall global copies. For cloud work, start Pi
with the collection explicitly:

```sh
pi --skill ~/.pi/skill-collections/aws
```

This adds AWS skills for that session while retaining the normal
harness skills. Ordinary Pi sessions omit the AWS catalogue. The
collection can also be named in a cloud-only project's `.pi/settings.json`
`skills` array; do not add it back to global settings. Reinstall the
collection through the toolkit on the next computer; it is upstream
material, not copied into this repository.

Pi has no automated MCP setup in the toolkit, hence `pi mcp add`
(user-level `~/.pi/agent/mcp.json`). This scoping changes skills only,
not the AWS MCP server or credentials.

[pi-cloud-agents/](pi-cloud-agents/) is vendored from
[AntApper/pi-cloud-agents](https://github.com/AntApper/pi-cloud-agents)
at `cf75c94`; compare against that commit before taking upstream
changes. Local commits on top fix the
upstream deployment and launch failures and move the runner to
Pi 1.4.0, which has the 5.5 models; use only current models, never
an older fallback.

The package is not on npm, so run it from source. Its `verify`
reports some checks (smoke run, network connector) as PASS without
running them; judge a deployment by a real run instead.

```sh
cd pi-cloud-agents && npm ci && npm run build
node dist/cli/main.js setup --non-interactive --skip-providers --profile backstage --region eu-north-1
node dist/cli/main.js config defaults.model.provider anthropic
node dist/cli/main.js config defaults.model.id claude-sonnet-5-5
node dist/cli/main.js config providers.synced anthropic
```

Configure provider credentials separately. To avoid syncing unrelated local logins, use a dedicated `PI_AGENT_DIR` containing the cloud configuration and only the intended provider configuration. Run the source CLI's `sync` command with that directory and the intended credential environment. Check the selected authentication source: a stored provider login can take precedence over an environment key. If your provider requires additional headers, configure them in `models.json`. Recheck the credential source after `update`, which resyncs local configuration. The `/cloud` extension and `attach` have not been validated in this setup.

### Scheduled one-shot cloud tasks (pi-tick, prototype)

A pi-tick job created with `--runner aws` (or `runner: "aws"` in
`tick_create`) runs in AWS at its requested time, whether or not this
Mac or Pi is running. One-shot jobs only. An EventBridge Scheduler
`at()` schedule (UTC, group `pi-tick`, deleted after firing) invokes
the `pi-tick-aws-launcher` Lambda. The Lambda starts a pi-cloud-agents
MicroVM, waits for its runner and submits the prompt. `/tick show <id>`
reads the launch record and the final assistant message from S3.
Implementation: [scheduled cloud tasks](pi-cloud-agents/scheduled/).

pi-tick is [gscode1/pi-tick](https://github.com/gscode1/pi-tick) (MIT)
at `74c9cd7` plus [a harness patch](patches/pi-tick-74c9cd7-aws-runner.patch).
The AWS side is `pi-cloud-agents/scheduled/` with its own stack next
to the core stack. Setup, after the cloud-agent setup above:

```sh
scripts/install-patched-pi-tick.sh
tick=~/.local/share/harness/pi-tick/extensions/tick
cd pi-cloud-agents && npm ci
export AWS_PROFILE=backstage
export AWS_REGION=eu-north-1
scripts/deploy-scheduled.sh
node "$tick/bin/pi-tick.mjs" config set \
  aws-helper "$PWD/dist/scheduled/cli.js"
pi -e "$tick"
```

The installer checks out into
`~/.local/share/harness/pi-tick` and refuses a non-empty
path. `pi -e` is for trials; use `pi install` once the
runner is adopted.

`pi-tick show <id> --json` returns the same record unformatted. The
scheduling identity needs `scheduler:CreateSchedule`, `GetSchedule`
and `DeleteSchedule` in group `pi-tick`, `iam:PassRole` on the stack's
`SchedulerRole`, `cloudformation:DescribeStacks` on `pi-tick-aws` and
S3 writes to `tick/tasks/*`. The core stack's operator policy does not include these permissions; configure them for the scheduling identity. Task records hold the prompt, repository and secret *names*;
secrets stay in Secrets Manager.

Limits of the prototype:

- **The VM lives until `--timeout-ms`** (default 30 minutes, at most
  8 hours), not until the agent finishes. The runner's `/v1/status`
  omits the lifecycle's `suggestedAction`, so the controller never
  suspends a settled run. The debounced session upload never fires
  either: `runner/main.ts` waits for a `raw_line` event that
  `pi-process.ts` never emits. The session reaches S3 in the runner's
  terminate hook, so there is no live transcript, and `/tick show`
  has the result only after the VM ends. Fixing both needs a runner
  image rebuild; test it in a separate image first, since the image
  is shared with ordinary cloud runs.
- **At most once.** Duplicate deliveries are ignored, and a launcher
  that fails after claiming the task is not retried. `/tick show`
  reports `launching` for up to 11 minutes, then `incomplete`.
- The run clones the job directory's `origin` branch as it is when
  the schedule fires; it does not pin a commit. `autoPush` is off.

To remove the stack, delete its schedules first, then:
`aws cloudformation delete-stack --stack-name pi-tick-aws`. Task
records and launcher zips remain under `tick/` in the core bucket.

## Delegated implementation reminder

Link `pi/prompts/implement.md` from this checkout into
`~/.pi/agent/prompts/implement.md` on each machine (`pi/`, like
`pi/extensions/`, is not discovered per project, so a worktree
adds no second `/implement`). Invoke
`/implement` with the delegation brief (or an attached brief
and a short pointer). Include the original user request and
subsequent decisions separately from the proposed approach.
Pi expands the scope reminder at invocation; ordinary prompts
bypass it. Existing sessions need `/reload`. The reminder
does not block tools or impose a fixed implementation plan.

Link `pi/prompts/browser-verify.md` the same way. Invoke
`/browser-verify` with a brief for browser verification or
configuration of a running application; it adds the same
scope check plus read-back evidence and stop-at-gate rules.

## Terminal session sidebar and browser QA

Installed trial: ccmux 1.4.4, tmux 3.8 and
`pi-playwright@0.1.2`. The browser skill works with the
current Node 25 runtime; pi-browser-actions 1.1.1 excludes
that runtime and was not installed.

On a new machine:

```sh
brew tap epilande/tap
brew install epilande/tap/ccmux tmux
ccmux setup --agent pi
pi install npm:pi-playwright@0.1.2
```

Version 0.1.2's skill examples use the obsolete `network`
command. Apply the tracked two-line correction after each
install of that version (already applied on this machine):

```sh
pkg="$HOME/.pi/agent/npm/node_modules/pi-playwright"
patch -p1 -d "$pkg" < \
  patches/pi-playwright-0.1.2-requests.patch
```

The current command is `requests`; this changes only the
skill examples, not the browser runtime.

The ccmux setup regenerates its Pi tracking extension at
`~/.pi/agent/extensions/ccmux.js` with the new machine's
home path. It reports session identity/activity; it does
not introduce a parallel code-quality workflow.
Install the Chromium build required by the package's
resolved Playwright CLI using that CLI's `install-browser`
command directly (the skill wrapper adds a session argument
which that setup command rejects).

Source [the shell shortcut](scripts/pi-shell.zsh) from your
`~/.zshrc`, using the checkout's location on that machine:

```sh
source /path/to/harness/scripts/pi-shell.zsh
```

Bare `pi` in an interactive terminal creates a window in
`pi-workspace` at the current directory and attaches to it.
Each terminal attaches its own view: a session grouped with
`pi-workspace` (the same windows), whose current window is
its own, so a monitor and the laptop screen can show
different Pis. The view closes when its terminal does. With
[the tab rows](tmux/pi-tabs.conf) installed, a plain
`tmux attach` to a session another terminal is showing gets
a view the same way ([the hook](scripts/tmux-view.sh));
a terminal alone in its session is left as it is. Tests:
`node --test scripts/tests/tmux-views.test.mjs` (its own tmux
servers, stub `pi` and sidebar; `CCMUX_BIN` picks the ccmux).
The launcher uses [the task wrapper](scripts/tmux-task.sh)
so exiting Pi also closes leftover sidebar-only panes.
Any additional shell or process pane is preserved.
Inside tmux it starts normally. Calls with arguments and
non-terminal calls pass straight through; `command pi`
also bypasses the shortcut. Existing terminals need to
source the snippet or restart. Existing Pi conversations
are not moved: exit the old process first, then use
`pi --resume` inside tmux to resume it.

For disposable agent/test windows, run the command through
`scripts/tmux-task.sh` as the window's foreground command.
Do not append a fallback shell; capture logs to a file when
needed. This wrapper preserves the command's exit status
and removes only sidebar-only leftovers after it ends.

Start Pi inside tmux, then run `ccmux sidebar --toggle`
from a shell inside tmux. Enable tmux mouse support for
clicking and `extended-keys` for modified Enter keys.
Persist Pi's preferred key encoding in `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
set -g mouse on
bind-key -n C-q run-shell "ccmux sidebar --toggle"
```

Apply it to a running server without restarting sessions:

```sh
tmux set -g extended-keys on
tmux set -g extended-keys-format csi-u
```
Press **Ctrl+Q** to hide or restore the sessions
sidebar, from Pi, Hunk or Neovim. With [the tab
rows](tmux/pi-tabs.conf) installed (sourced after the line
above, so it replaces it), Ctrl+Q acts on the window you are
looking at only, through [a small script](scripts/tmux-sidebar.sh)
using ccmux's configured width and side (and ccmux's resize
hook, which keeps that width when a window resizes); another screen
changes only if it shows that window. Without it, ccmux's
built-in toggle opens or closes sidebars in every window, and
`ccmux sidebar --toggle` still does. New windows follow
ccmux's auto-open setting from that toggle. Drag the vertical
divider between panes to adjust their width (no resize
pointer appears; press on the divider itself). Agent and
preview panes stay running. For an existing server, apply
the binding with `tmux source-file ~/.tmux.conf`.

### New Pi from the sidebar

With the sidebar grouped by directory (`g` cycles grouping),
each directory heading has a `+ New Pi` line under it.
Clicking it starts a fresh Pi in exactly that directory, in a
new window of the same tmux session, and switches to it;
quitting that Pi closes its window, sidebar included. This is
a harness patch to ccmux v1.4.4 (upstream commit `643fe6a`,
MIT), kept in [patches](patches/ccmux-1.4.4-new-pi-row.patch)
with [a second patch](patches/ccmux-1.4.4-grouped-sessions.patch)
for the per-terminal views above: without it, Ctrl+Q opens one
sidebar per view in every window, the daemon counts each
agent once per view, and a sidebar, "+ New Pi" or notification
jump can move the other screen (a bare pane target resolves in
whichever view was used last). A [third
patch](patches/ccmux-1.4.4-worktrees-group.patch) puts every
session in an agent-made worktree (a folder inside one named
`*-worktrees`, such as `example-worktrees/task-123`) into one
collapsible "worktrees" group at the bottom, without a
`+ New Pi` line. Those sessions have orchestrating agents, so
they never join the "needs attention" band. A [fourth
patch](patches/ccmux-1.4.4-switch-client-focus.patch) moves the
highlighted (active) session when a terminal switches with
`switch-client` (a sidebar row, a jump, the Windows tab row), not
only on `select-pane`/`select-window`; the daemon installs those
hooks when it starts, so restart it after installing. All four are built by
[the installer](scripts/install-patched-ccmux.sh), which needs
`bun`:

```sh
scripts/install-patched-ccmux.sh
```

It clones the pinned tag, checks the commit, applies the patches,
runs the changed files' tests, and installs `~/.local/bin/ccmux`
(which must come before Homebrew's on `PATH`, in shells and in
tmux) and `~/.local/bin/ccmux-pi`, the launcher the line starts
(`exec scripts/tmux-task.sh pi`). In
`~/.config/ccmux/ccmux.json` it sets only
`agents.pi.executable` to `exec ~/.local/bin/ccmux-pi`. The
Homebrew ccmux is left in place. The patch also makes the
daemon pass directories containing `#` to tmux literally. The
daemon reads that setting only when it starts, so restart it
with the patched build (`ccmux daemon restart`, which `PATH`
resolves to `~/.local/bin/ccmux`; running agents are
unaffected), then restart the sidebars (`ccmux sidebar --toggle`
twice). The
install path must need no shell quoting. Rollback: delete `~/.local/bin/ccmux` and
`~/.local/bin/ccmux-pi`, remove `agents.pi.executable`, and
restart the daemon and sidebars.

To try a ccmux build away from the live sidebars, give it its own
`CCMUX_PORT` as well as `CCMUX_HOME`. On the default port, a sidebar
of a different build replaces the running daemon with one started
in its own environment. A sidebar in a disposable tmux server once
left the live daemon watching that server, and every sidebar
showed no sessions until the daemon was restarted from the real one.

When a Pi turn's tool calls change what the repository's
working diff shows, the [diff pane extension](pi/extensions/diff-pane.ts) opens
`hunk diff HEAD --watch` in a split beside that Pi pane,
leaving Pi focused. It compares the files' content and mode
before the turn's first mutating call with their state after
the whole turn, so parallel calls never see a sibling's
half-finished `git checkout`/`pull`; staging, timestamps,
and turns that move HEAD (checkout, pull, commit, reset)
open nothing. A turn that both moves HEAD and edits files
opens nothing either; the next editing turn does. It shows the whole working diff (staged,
unstaged and untracked), including changes that predate the
prompt, not only the agent's edits. The tracked
[sorting extension](extensions/hunk/recent-files.mjs) puts
recently modified files first and reapplies on live refresh.
It uses filesystem timestamps, not agent attribution;
deleted/unavailable files follow dated files, with ties
keeping their existing order. Existing changes,
read-only tools and changes that leave a clean tree do not
open it. Whenever Hunk itself would show "No changes to
review." (zero files after its own loading, at start or
after a live refresh), the
[close-when-empty extension](extensions/hunk/close-when-empty.mjs)
exits it and marks the Pi pane, so a later change in the same
prompt reopens it; a file filter that hides every file
keeps it open. Press `q` in Hunk to close it; it stays closed
until the next prompt. Pi keeps its previews across
`/reload` and `/new`, and closes them on `/quit` or Ctrl-D (an editor with unsaved text stays). If Pi
is stopped by a signal (`kill`) or loses its owner pane, surviving previews stay open, saved or not, as
ordinary windows listed in the Windows row; close them yourself, or resume that session (`pi -c`,
`pi --resume`), in any pane, which takes them back instead of opening new ones: the editor keeps its
unsaved text and its document tabs. Closing an entire window destroys its saved panes; the window-bar
close action first moves an editor with unsaved text out. A process that dies back to a surviving shell
without a shutdown signal is detected on the next orphan sweep, triggered by a pane or window closing.
Other Pi sessions leave them alone. If something
still runs in the old Pi's pane, Pi says so and opens no second editor by itself (`/edit` still does).
Previews opened before this behaviour existed are not recognised: save and close them yourself.

Only one preview is visible beside Pi. Others (another
repository's Hunk, or the editor) wait in their own windows
of Pi's tmux session. With [the tab rows](tmux/pi-tabs.conf)
installed, the bottom of the terminal has two labelled rows:

- `Windows`: the session's windows as `index:name` (`*` on
  screen, `-` previous). `π` marks a window running Pi.
  Waiting previews are not listed here. Click a name to show
  that window; click its `×` for a menu (Keep window first,
  also on Escape) that says what closing ends, including a
  Pi session. An editor with unsaved text in that window
  moves to its own `edit` window instead of closing; a
  closed Pi's other previews stay as ordinary windows.
- `Panels`: for the Pi you are in (or whose preview you are
  in; also while the ccmux sidebar is active, when one Pi
  runs in the window): `Diff: <repository>` per open Hunk and
  a tab per Markdown document of that Pi, `●` when unsaved,
  what is beside Pi highlighted. Documents are every
  Markdown file the agent changed, opened with `/edit`, or
  chosen in `/panels`, and skill Markdown the agent edited
  anywhere (below); they stay tabs until closed, across
  `/reload`, and whether or not the editor is open. Clicking
  a document shows it in the one editor beside Pi (starting
  it if needed); the document left keeps its unsaved text.
  An agent change does not switch away from unsaved text; it
  adds the tab and notes it in the editor. `×` on a Hunk
  closes it (dismissed until the next prompt). `×` on a
  document closes only that document; with unsaved text it
  asks first: Keep editing (also Escape), Save and close
  (refuses a file changed on disk and reports write errors,
  staying open), or Discard and close. Closing the last
  document closes the editor. Repositories without changes
  have no tab.

Install by adding one line to `~/.tmux.conf`, with this
checkout's path on that machine, then
`tmux source-file ~/.tmux.conf` (running sessions stay):

```tmux
source-file /path/to/harness/tmux/pi-tabs.conf
```

It needs `node` on the tmux server's `PATH` (Node 22.18 or
later, which imports the TypeScript helper directly) and
`perl`, whose `flock` serialises document changes between
Pi and tab clicks (preinstalled on macOS and most Linux). It
replaces `status-left`, the window formats and the default
`MouseDown1Status` binding; any other status click behaves
as before. Pi redraws Panels when its previews change; the
editor and the [task wrapper](scripts/tmux-task.sh) redraw it
when the editor's file or unsaved state changes or a preview
exits. Editors opened before installing lack the hooks: their
`●` updates only when Pi redraws, and closing a document from
the tab reports a failure and leaves it open; close such an
editor with `q` and reopen documents from their tabs. Pi asks
the editor itself what is unsaved (`PiMarkdownState`), so an
editor started by an older harness shows no `●` and is treated
as holding unsaved text until it is reopened. A Pi
started before installing shows document tabs after its next
`/reload`. The ccmux sidebar lists Pi sessions; it
is separate from both rows.

`/panels` also opens a selector in Pi, styled like `/model`'s:
type to filter, ↑↓ to move, Enter to show, Esc to cancel. It
lists repositories (one with changes but no Hunk, closed or
changed before this prompt, opens; clean ones are dimmed and
cannot be chosen), this Pi's documents, Markdown changed or
new in those repositories by Git's view, then every other
Markdown file in them (tracked or untracked, not ignored),
the top level of a working directory outside Git, and the
top level of its parent folder, each with where it is.
Choosing a file opens it as `/edit` does and makes it a
document tab.
`/panel` cycles to the next preview; `/panel edit` shows the
editor. `/panel <repository>` uses the repository's folder
name to show its open diff or open a changed repository
listed by `/panels`, including a launched worktree. A clean
repository with no open diff reports no changes to show.
Any other name is a document: `/panel PLAN.md` opens a file
as `/edit` does,
or picks the document tab of that name (two tabs with one
name need the path). Switching swaps
panes, so nothing restarts and unsaved edits stay. A turn's
change takes the visible slot (the editor first, then the
first changed repository), unless the visible preview is the
active pane or an editor with unsaved text; Pi then says
which `/panel` shows it. After `/reload`, Pi adopts its open
previews. On quit a waiting editor comes back beside Pi
before the unsaved check. Previews run under the task
wrapper, so a waiting window closes with its preview rather
than leaving a ccmux sidebar behind.

A linked worktree (`git worktree add`, as sandbox and
verification runs make) also watches the main checkout it was
made from, with no configuration: its changes open diffs and
its Markdown is listed in `/panels`. A main checkout, or a
worktree of a bare repository, adds nothing. Tests:
`node --test scripts/tests/preview-roots.test.mjs`.

The other way round, a worktree a session works in (as an
orchestrator does before handing work to an agent there) can
be watched like the session's own repository: a turn that
changes it opens its diff beside Pi, and `/panels` lists it
with its change count and changed Markdown after the
session's own repositories. A worktree becomes the session's
when the agent edits or writes a file in it with its own
tools, or when it is chosen by its top-level folder:
`/panel ../my-worktree`, or the agent's `show_panel` with
that path, whose description asks the agent to do this after
creating a worktree with a command or script. The choice is
recorded in the session, so it lasts across `/reload` and
resume, until the worktree is removed; a new session starts
without it. Nothing is inferred from commands or from a
worktree appearing in `git worktree list`, which another agent
may have made; records from before this change are not read.

Diffs leave out the page snapshots Playwright's CLI writes into
a `.playwright-cli` folder wherever it runs: they neither open
a diff nor count as changes.

To preview another repository's changes too, list it in the
working repository's Git config, relative to its top level:

```sh
git config --worktree --add pi.previewRoot ../notes-repository
```

`--worktree` (with `extensions.worktreeConfig` enabled)
keeps it to that checkout; plain `git config` applies to all
its worktrees. Every mutating turn then compares each listed
repository against its own HEAD, including shell edits;
aliases of one repository count once. A value that is not
a Git repository is skipped with a single warning.
Outside tmux, and in print/RPC child processes, it does
nothing. `HUNK_MCP_DISABLE=1` stops Hunk from starting its
background session daemon, so Hunk's agent-session commands
do not reach this pane. Tests:
`node --test scripts/tests/diff-pane.test.mjs` (disposable
tmux server and scripted model; no model calls).
`/readfiles` remains available for browsing files.

Use `/edit PLAN.md` to open an existing document on demand,
without an agent edit or Git diff. Paths are relative to
Pi's working directory; absolute paths and spaces work too.
This reuses the same editor, shows it beside Pi, and respects unsaved edits.
`/create notes/idea.md` makes a new empty file there and opens
it the same way. It never overwrites an existing file and does
not create missing folders.

The agent can do what `/panel` does through its `show_panel`
tool: a file path opens that document in the editor, and a tab
or repository name shows that preview. With no name, it cycles
to the next preview. The interactive `/panels` menu stays with
the user.

When a turn changes Markdown (`.md`, `.markdown`) instead,
the extension opens the newest changed document in an
editable Neovim beside Pi; code changes in the same turn
also open Hunk, waiting in its own window. Skill Markdown
(`SKILL.md`, or Markdown in a folder below one) that the
agent's `edit` or `write` tool changes opens the same way,
wherever it lives and whether or not Git tracks it, such as
`~/.agent-skills`; a skill changed only through `bash` does
not. Neovim runs as
`NVIM_APPNAME=pi-markdown nvim -u nvim/pi-markdown/init.lua`,
so personal Vim/Neovim settings are neither read nor
changed. [The install script](scripts/install-markdown-editor.sh)
pins render-markdown.nvim v8.14.0 under
`~/.local/share/pi-markdown`; Neovim 0.12's bundled
Markdown parsers suffice. Icons are plain Unicode; no Nerd
Font is needed. Optional HTML, LaTeX and YAML frontmatter
rendering is not installed. A read-only index of common keys
sits above the document (outside typing, every key is a
command): `i` to type, `Esc` to stop, `w` to save and `q` to
close (asks about unsaved edits), undo, delete, paste and
find. Clicking it returns to the document. The line beneath
it names the document and shows the warnings below.

The editor starts in the home directory, not the document's
folder, so removing a worktree cannot leave it without a
working directory (which broke rendering on every redraw);
if its directory disappears anyway, it moves home. A
document whose file has been gone for three seconds closes,
and its Panels tab disappears, unless the buffer has unsaved
text, which stays with a "File removed from disk" note.
Closing the last document closes the editor. A tab returns
if the file is recreated.

Unsaved edits stay yours. A clean buffer follows agent
writes and switches to the next changed document; a
modified one does neither. It shows "Also requested: <file>" or
"Changed on disk; edits kept", and Neovim's own write check
asks before `:w` overwrites the agent's version (`:e!`
loads it instead). Both checks use size and modification
time, so a write that restores the file's exact original
size and mtime goes undetected. Pi quit closes the editor only when
nothing is unsaved; otherwise it stays open with a notice.
Reload keeps it; `q` dismisses it until the next prompt.
Without Neovim, Markdown changes open in Hunk. Tests:
`node --test scripts/tests/markdown-editor.test.mjs`.

Browser QA: request the `playwright-browser` skill and a
headed browser when you want to watch. Concurrent agents
must use distinct `PLAYWRIGHT_CLI_SESSION` values or explicit
`-s=<name>` arguments: the package default is per project,
not per agent. Reuse a name only for intentional sharing.

Verified on 26 October: two running Pi processes discovered
by ccmux; QA activity changed from working to idle; Sol
loaded the skill and inspected a visible example.com page.
Two explicit browser sessions had separate localStorage.
The page had title Example Domain and no h1; the agent
reported that accurately. Browser windows remain separate
from the terminal. Mouse switching has not been visually
verified in an attached user terminal.
