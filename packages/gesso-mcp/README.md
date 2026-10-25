# gesso-mcp

The [Gesso](https://github.com/bolenX/gesso) MCP server. AI agents build layered images as data, render previews, and export PSDs that stay editable in Photoshop: live text, shape and adjustment layers, layer styles, artboards and smart objects.

It includes Photoshop's Filter menu as smart filters, every adjustment layer, all blend modes and layer styles, Blend If and luminosity, colour-range and channel masks, boolean shapes, distort and warp, and retouching (content-aware fill, healing, clone stamp, content-aware scale).

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

Host it for claude.ai or ChatGPT with `npx -y gesso-mcp --hosted`: each user gets a private workspace and connector URL. See the [hosting guide](https://github.com/bolenX/gesso/blob/main/docs/hosting.md).

## Tools

`canvas_list`, `canvas_create`, `psd_import`, `canvas_outline`, `canvas_get`, `canvas_selection`, `canvas_patch`, `canvas_history`, `canvas_render` (previews, region zoom up to 400%, before/after compare), `canvas_inspect` (histogram, clipping, colour cast, sharpness, noise, eyedropper samples), `canvas_export` (PNG, JPEG, WebP, TIFF, PSD, SVG, PDF with bleed and crop marks; RGB or CMYK with ICC profiles; slices from layer names), `canvas_stamp`, `canvas_align` (Auto-Align Layers), `canvas_stack` (Auto-Blend Layers: focus stacks and exposure fusion), `canvas_batch`, `artboard_create`, `font_list`, `asset_import`, `skill_read`, `skill_apply` (a skill's recipe as one revision). `gen_prepare` hands image jobs to the image tools you have connected: expand (one plate for every size), generate, fill, segment (subject, sky, skin, eyes, lips…, returned as masks), remove-background and upscale.

## Skills

Thirty bundled skills cover:

- filters, adjustments, compositing, retouching and production
- 50 core Photoshop techniques
- workflows for beauty, product, real estate, photo manipulation and restoration
- graphic design: type hierarchy, grids, brand application, posters, duotone, double exposure
- adapting a design to channels, sizes, safe zones and RTL languages

Agents read them with `skill_read`, and each one is also an MCP prompt. Most skills include recipes, proven layer setups that `skill_apply` fills in and applies in one step. Each recipe is tested by examples that check the result with measurements.

Apache-2.0.
