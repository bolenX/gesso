# gesso-mcp

The [Gesso](https://github.com/bolenX/gesso) MCP server. AI agents build layered images as data, render previews, and export PSDs that stay editable in Photoshop: live text, shape and adjustment layers, artboards and smart objects.

## Install

Claude Code:

```sh
claude mcp add gesso -- npx -y gesso-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "gesso": { "command": "npx", "args": ["-y", "gesso-mcp"] } } }
```

Requires Node 22 or later. Assets and exports resolve relative to the folder the agent runs in, or to `GESSO_WORKDIR` when it's set (a leading `~` means your home folder).

Run it as a hosted connector with `npx -y gesso-mcp --http 3333`, then add `https://your-host/mcp` as a custom connector.

## Tools

`canvas_list`, `canvas_create`, `canvas_outline`, `canvas_get`, `canvas_selection`, `canvas_patch`, `canvas_history`, `canvas_render`, `canvas_export` (PNG, JPEG, WebP, PSD), `font_list`, `asset_import`. `artboard_create` and `gen_prepare` are planned.

Apache-2.0.
