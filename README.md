# Gesso

**A headless, agent-first image engine: "Remotion for Photoshop".**

Agents create and edit layered compositions as data, and every output opens in Photoshop as a fully editable PSD. The headless core ships first. A human-facing canvas UI follows later as a client of the same API.

> Status: pre-alpha. The document IR, selectors, outline view, atomic patches and revision history work. The renderer, PSD round-trip and generative broker are not built yet. See [docs/spec-v0.1.md](docs/spec-v0.1.md).

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
packages/mcp-server  @gesso/mcp-server: MCP tool surface (canvas_*, artboard_*, asset_*, gen_*)
skills/              Bundled skills (SKILL.md, recipe.json, checks.md, examples/)
docs/                Technical spec
```

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
