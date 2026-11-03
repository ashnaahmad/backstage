# Backstage

A terminal workspace for coding and writing with agents. Built around [Pi](https://pi.dev), tmux and an editable Markdown side pane, with Claude and GPT sharing one quality workflow.

The agent can work while you read its diff, edit a document or switch to another session. Keep the requested outcome stable; let evidence change the implementation plan.

## What is here

- **Sessions and panels.** A patched ccmux sidebar launches and switches Pi sessions. Two clickable tab rows separate agent windows from documents and diffs. Hunk opens when code changes; Markdown opens in Neovim, preserving unsaved edits.
- **One quality workflow.** A reusable skill guides implementation and verification. Pi tools report progress and request independent review from the other model provider. Advisory feedback flags newly added chronology in standing documents.
- **Writing guidance.** Shared principles with separate Claude and GPT references, loaded when relevant. An editor alongside the agent supports direct writing, saving and document switching.
- **Phone access.** A ttyd terminal exposed through a private Tailscale connection, with a paste field and touch controls for focus, sidebar width and Markdown editing.
- **Cloud experiments.** Vendored pi-cloud-agents and a patched pi-tick path for one-shot AWS tasks. These remain experimental; see the limitations in [setup](SETUP.md#aws-cloud-agent-experiment).

## Start here

Clone this repository, then follow [SETUP.md](SETUP.md). Setup is explicit: install the pinned packages, configure global Pi paths and authenticate your own accounts. Review scripts before running installers; mobile and cloud components are optional.

[REQUIREMENTS.md](REQUIREMENTS.md) lists dependencies and observed versions. The setup has been used on macOS/Apple Silicon; a clean-machine installation rehearsal remains outstanding. The checked-in model selection is a configurable example, subject to your provider's model catalogue and account access.

## Writing surfaces

| Command or control | Result |
| --- | --- |
| `/edit path/to/file.md` | Open an existing document beside Pi |
| `/create notes/idea.md` | Create and open a document; the folder must exist |
| `/panels` | Choose a repository diff or document |
| `/panel path/to/file.md` | Show a document directly |
| Bottom Panels tabs | Switch or close open documents and diffs |
| Ctrl+Q | Hide or restore the session sidebar |
| Editor `i`, Esc, `w`, `q` | Type, stop typing, save, close |
| `/quality` | Inspect quality progress and review results |
| `/readfiles` | Browse files using Files Widget |
| `/studio file.md` | Open Pi Studio's browser writing surface |
| `/preview-browser --watch file.md` | Open a live browser preview |

The editor uses Vim navigation outside insert mode. Its header shows controls. Unsaved text is retained when switching documents; closing unsaved work asks what to do.

## Repository map

- [Pi extensions](pi/extensions/) and [prompt templates](pi/prompts/)
- [Skills](skills/): code quality, writing, skill creation and [three-way conversation](skills/three-way-conversation/SKILL.md) with a bundled [Claude companion](skills/claude-companion/SKILL.md)
- [Scripts and tests](scripts/), [Neovim configuration](nvim/) and [tmux configuration](tmux/)
- [Mobile controls](mobile/) and [Hunk extensions](extensions/hunk/)
- [Pinned upstream patches](patches/) and [cloud experiment](pi-cloud-agents/)
- [Plan](PLAN.md) and [contributor instructions](AGENTS.md)

## Licence and upstream projects

Original Backstage work is [MIT licensed](LICENSE). Upstream components retain their own licences; see [THIRD_PARTY.md](THIRD_PARTY.md). Backstage builds on Pi, ccmux, Hunk, Neovim and their extension ecosystems.
