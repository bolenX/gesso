<p><img src="packages/mcp-server/assets/logo.svg" alt="Gesso" width="280"></p>


**A headless, agent-first image engine: "Remotion for Photoshop".**

Agents create and edit layered compositions as data, and every output opens in Photoshop as a fully editable PSD. The headless core ships first. A human-facing canvas UI follows later as a client of the same API.

> Status: pre-alpha. The document IR, atomic patches, revision history, the renderer (PNG/JPEG/WebP via Skia) and layered PSD export work. PSD import and the generative broker are not built yet. See [docs/spec-v0.1.md](docs/spec-v0.1.md).

## Principles

- **Agent-first.** Agents change structured data through small, ID-addressed patches. There is no mouse emulation.
- **Non-destructive.** Source assets stay untouched. Every change is a patch in an event log, so every change can be undone and traced to its author.
- **The document IR is the product.** Renderers and file formats, PSD included, are backends that can be swapped out.
- **Lossless PSD round-trip.** PSD data Gesso can't render is kept as opaque blocks and written back unchanged.
- **Skills carry the craft.** The engine makes edits possible. The bundled skills make them good.
- **The project never pays per generation.** Generative work goes to the user's own connected tools, API keys or hardware.

## Scope

| Tier | Features | Support |
| --- | --- | --- |
| Core (v0.1) | Artboards, layers, groups, masks, clipping, 16 standard blend modes, text, shapes, main adjustments, transforms | Render, edit, round-trip |
| Design (v0.2) | Layer styles, smart objects, smart filters, Photoshop-only blend modes | Render, edit, round-trip |
| Pixel (v0.3) | Brush, eraser, clone, heal as stored stroke data; mesh warp | Render, edit, round-trip |
| AI-native | Expand, fill, background removal, relight, upscale, segmentation, face parsing | Sent to the user's providers; results stored as layers with provenance |
| Out of scope | 3D, video timeline, Actions, plugins, print separations | Preserved on round-trip, never rendered |

## Repository layout

```
packages/core        @gesso/core: Zod schemas for the IR, patches, selectors, outline view
packages/render      @gesso/render: evaluator (Skia via CanvasKit, Sharp for decode and encode)
packages/psd         @gesso/psd: PSD encoder (ag-psd): artboards, live text, shape and adjustment layers
packages/mcp-server  @gesso/mcp-server: MCP tool surface (canvas_*, artboard_*, asset_*, gen_*)
skills/              Bundled skills (SKILL.md, recipe.json, checks.md, examples/)
docs/                Technical spec
```

## Install

Add Gesso to Claude Code with one command. `npx` downloads and starts it; there is nothing to clone or build.

```sh
claude mcp add gesso -- npx -y gesso-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "gesso": { "command": "npx", "args": ["-y", "gesso-mcp"] } } }
```

Then ask for a design, for example: "Make a 1080×1350 poster that says Hello from Gesso, show me a preview, then export a PSD to out/." Assets and exports resolve relative to the folder Claude runs in. Requires Node 22 or later.

To host Gesso as a connector, run `npx -y gesso-mcp --http 3333` behind HTTPS and add `https://your-host/mcp` as a custom connector.

Working on Gesso itself? The repo's `.mcp.json` loads your local checkout as the `gesso` server in any Claude Code session opened here.

## Publishing gesso-mcp

```sh
pnpm install
node packages/gesso-mcp/build.mjs
cd packages/gesso-mcp && npm publish
```

Bump `version` in `packages/gesso-mcp/package.json` before each release.

## Development

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build && node packages/mcp-server/dist/bin.js   # MCP server over stdio
```

## Licence

[Apache-2.0](LICENSE)
