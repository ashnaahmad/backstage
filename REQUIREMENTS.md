# Migration requirements

Assessed 26 October 2026 on macOS/Apple Silicon. This is a
human-readable dependency list; installation and authentication
steps are in [SETUP.md](SETUP.md). A fresh-machine rehearsal is
still outstanding. “Observed” versions describe this machine,
not minimum supported versions.

## Core workspace

| Dependency | Requirement / purpose | Observed version |
| --- | --- | --- |
| Node.js + npm | Node >=22.19.0, the installed Pi package’s declared minimum; also satisfies the installed browser dependencies | Node 25.3.0 |
| Pi | Install the version used by this setup | 1.4.0 |
| Claude Code | Bridge backend; install and authenticate separately | 2.1.304 |
| Git | Repository operations and diffs | 2.52.0 |
| Python 3 | Harness handoff probe scripts | 3.14.7 |
| tmux | ccmux session sidebar and the automatic diff pane; also Studio’s optional REPL | 3.8 |
| Hunk | Automatic live diff pane beside Pi in tmux | 0.24.1 |
| Neovim + render-markdown.nvim | Editable Markdown pane beside Pi; uses Neovim’s bundled Markdown parsers; renderer pinned by `scripts/install-markdown-editor.sh` | 0.12.6 / v8.14.0 |
| ccmux | Pi session tracking/sidebar; the harness `+ New Pi` patch is built by `scripts/install-patched-ccmux.sh` | 1.4.4 |
| Bun | Builds the patched ccmux (`scripts/install-patched-ccmux.sh`) | 1.3.10 |
| Perl | Holds the document lock shared by Pi and the Panels tab helper (`flock`); preinstalled on macOS and most Linux | 5.34.1 |
| bat, delta, glow | Files widget checks for all three commands; Homebrew calls delta `git-delta` | 0.26.1 / 0.20.1 / 3.0.0 |
| Pandoc | Markdown preview rendering and Studio’s full previews/exports | 3.9.0.2 |

Re-authenticate Claude and GPT with the intended accounts;
credentials must be configured separately.
No Java or Docker installation is required for these core features.

## Extension packages and browsers

[.pi/settings.json](.pi/settings.json) is the authority for the
extension package pins; do not maintain a second pin list here.
Their npm dependencies install with them. Top-level pins do not
freeze transitive dependencies, so rerun the setup smoke checks
after installation rather than assume identical resolution.

- **Playwright QA:** install the browser build required by the
  resolved Playwright CLI. This machine resolved `@playwright/cli`
  0.1.22 and Playwright `1.64.0-alpha-1790635538000`, using
  Chromium revision 1247. Use that installed CLI’s
  `install-browser chrome-for-testing`, not an arbitrary browser
  download. Apply the 0.1.2 skill patches
  ([`requests`](patches/pi-playwright-0.1.2-requests.patch), then
  [Chrome bridge](patches/pi-playwright-0.1.2-chrome-bridge.patch)) as
  described in SETUP.md.
- **Markdown image previews:** a renderer-supported Chromium
  browser and an image-capable terminal. Browser previews do not
  require terminal image support. Check image display through the
  chosen terminal/tmux combination during migration.

## Optional features — install only when used

- **Claude companion / three-way conversations:** Claude Code, zsh and Python 3 on PATH. The wrapper is bundled under `skills/claude-companion/scripts/`; credentials and Claude session history are configured separately.

- **Mobile terminal:** `brew install ttyd` (tested 1.7.7,
  Homebrew revision 14) plus Tailscale on the Mac and phone;
  macOS for the LaunchAgent. See [SETUP.md](SETUP.md#mobile-terminal).
  Remote access uses the private tailnet, not public Funnel.

- **PDF export:** a LaTeX engine. Mermaid PDF rendering also needs
  Mermaid CLI; Studio documents >=11.12. These are not part of
  the current tested feature set.
- **Studio Quarto previews:** Quarto. **Java REPL:** a JDK providing
  `jshell`. Other REPLs need their selected language runtime;
  installing Studio does not require installing every runtime.
- **AWS cloud-agent experiment:** AWS CLI v2 (observed 2.39.0)
  from AWS's user-local installer
  (`https://awscli.amazonaws.com/v2/install.sh`, installs to
  `~/.local/share/aws-cli` with `~/.local/bin/aws`). Homebrew's
  `awscli` 2.39.0 failed here: its Python 3.15 `pyexpat` linked
  the system `libexpat`, which lacks a required symbol. The AWS
  MCP proxy runs through `uvx` (observed uv 0.9.26). Setup
  commands are in [SETUP.md](SETUP.md#aws-cloud-agent-experiment);
  vendored `pi-cloud-agents/` needs Node >=22.19.
- **Scheduled cloud tasks (prototype):** pi-tick
  (`gscode1/pi-tick` at `74c9cd7`, MIT) with the harness
  patch, installed by `scripts/install-patched-pi-tick.sh`.
  The `pi-tick-aws` stack and
  `@aws-sdk/client-scheduler` are in `pi-cloud-agents/`. See
  [SETUP.md](SETUP.md#scheduled-one-shot-cloud-tasks-pi-tick-prototype).

## Evidence and upkeep

Checked installed package manifests (Pi, bridge, Playwright CLI,
preview and its Puppeteer dependency), files-widget command
checks, Markdown’s Pandoc invocation, Studio’s REPL command
selection and optional-feature documentation, plus local binary
versions. No minimum is asserted where it was not established.
When adding an extension, update this file only for new external
requirements; keep commands in SETUP.md and pins in settings.
