# Gesso plugin

Gesso is a layered image editor for your agent. It designs posters, social posts and banners, adapts one design to other sizes, retouches and grades photos, makes cut-outs of hair and glass, and exports PSDs that open in Photoshop with their layers still live. It also exports PNG, JPEG, WebP, TIFF, SVG and print PDF.

This plugin connects your agent to Gesso's free hosted server and adds Gesso's skills: 31 professional workflows (retouching, compositing, cut-outs, adapting sizes, duotone, print production and more) and a get-started guide. Nothing to install, and no account needed.

## Install

| Agent | How |
| --- | --- |
| Claude (claude.ai, Cowork, Claude Code) | In Claude Code: `/plugin marketplace add bolenX/gesso`, then `/plugin install gesso@gesso`. In claude.ai or Cowork: **Customize › Plugins › Add › Add marketplace**, and enter `bolenX/gesso`. |
| ChatGPT and Codex | In Codex: `codex plugin marketplace add bolenX/gesso`, then `/plugins`. |
| GitHub Copilot (CLI and VS Code) | `copilot plugin install bolenX/gesso:plugins/gesso`. In VS Code, run **Chat: Install Plugin from Source**. |
| Cursor | Add the plugin from Cursor's marketplace, or from this repository. |

The first time a Gesso tool runs, your agent opens Gesso's sign-in page. Choose **Continue without an account**.

## What goes to Gesso's server

Your agent sends Gesso's tools the documents it builds, and any images, fonts or PSDs you upload or give it a link to. These go to `https://mcp.gesso.run`, which keeps them in a private workspace for your connection. A workspace is deleted 7 days after it was last used. Gesso doesn't use AI models, and doesn't send your files anywhere else. See the [privacy policy](https://gesso.run/privacy) and [terms](https://gesso.run/terms).

**Prefer to keep files on your own computer?** Run Gesso locally instead: `npx -y gesso-mcp` (Node 22 or later), or the Claude Desktop extension. See the [install guide](https://github.com/bolenX/gesso/blob/main/docs/install.md).

## Support

Report problems at [github.com/bolenX/gesso/issues](https://github.com/bolenX/gesso/issues), or see [gesso.run/support](https://gesso.run/support).

Gesso is free and open source, under the Apache-2.0 licence. Photoshop is a trademark of Adobe Inc. Gesso is not affiliated with or endorsed by Adobe.
