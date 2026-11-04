# Third-party material

Backstage's MIT licence covers original work. The following bundled material retains its upstream licence and copyright notices.

| Material | Upstream source | Licence |
| --- | --- | --- |
| `pi-cloud-agents/` (modified) | [AntApper/pi-cloud-agents](https://github.com/AntApper/pi-cloud-agents), base `cf75c94` | [MIT](pi-cloud-agents/LICENSE) |
| ccmux patch context and modifications | [epilande/ccmux](https://github.com/epilande/ccmux), v1.4.4 (`643fe6a`) | [MIT](licenses/ccmux-MIT.txt) |
| pi-tick patch context and modifications | [gscode1/pi-tick](https://github.com/gscode1/pi-tick), `74c9cd7` | [MIT](licenses/pi-tick-MIT.txt) |
| pi-playwright skill patches | [guwidoe/pi-playwright](https://github.com/guwidoe/pi-playwright), 0.1.2 | [MIT](licenses/pi-playwright-MIT.txt) |

Installers fetch additional projects rather than bundling their complete source: Pi and its npm extensions, Hunk, Neovim, render-markdown.nvim, tmux, ttyd and Tailscale. Those projects and their dependencies retain their own licences. Package pins are in [.pi/settings.json](.pi/settings.json); installer pins are in [scripts](scripts/).

The cloud directory is a modified source snapshot. Historical upstream plans and execution logs are omitted; upstream descriptions of capabilities are not evidence that every path works in this configuration. Follow [SETUP.md](SETUP.md#aws-cloud-agent-experiment) for this setup's status and limitations.
