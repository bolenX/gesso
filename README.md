<p><img src="packages/mcp-server/assets/logo.svg" alt="Gesso" width="280"></p>


**A headless, agent-first image engine: "Remotion for Photoshop".**

Agents create and edit layered compositions as data, and every output opens in Photoshop as a layered, editable PSD. The headless core ships first. A human-facing canvas UI follows later as a client of the same API.

> Status: alpha. See [docs/spec-v0.1.md](docs/spec-v0.1.md).

What works today:

- **Document and editing:** the document IR, atomic patches with revision history, and PSD import and export (artboards, live text, shapes, adjustments, layer styles, smart objects, and smart filters wherever Photoshop has the same filter).
- **Exports:** SVG, print PDF, and PNG/JPEG/WebP/TIFF, in RGB or CMYK with ICC profiles.
- **Filters:** Photoshop's whole Filter menu as smart filters (121 filters), including the whole Filter Gallery, Blur Gallery, Liquify, Puppet Warp, Adaptive Wide Angle, Vanishing Point, Flame, Tree, Relight, Color to Alpha and Camera Raw.
- **Adjustments:** every adjustment layer, plus the Image › Adjustments commands as filters.
- **Compositing:** all blend modes, Blend If, luminosity, colour-range, channel and Calculations masks, Select and Mask edge refining with Decontaminate Colors, and every layer style.
- **Merging exposures:** Auto-Align and Auto-Blend for focus stacks and exposure brackets.
- **Shapes and transforms:** boolean shapes, skew, distort, perspective and warp.
- **Retouching:** content-aware fill, healing, clone stamp and content-aware scale.
- **Production:** batch runs, slices, and jobs prepared for the user's own image models: Generative Fill and Expand (one plate for every size), and Select Subject, Select Sky and face parts as masks that follow the photo.
- **Skills:** 31 skills, each with checks, and most with recipes applied in one step (`skill_apply`) and tested by examples. They cover retouching, grading and compositing workflows (beauty, product, real estate, manipulation, restoration), cut-outs (hair, fur, glass, smoke), graphic design (type, grids, brand, posters, duotone) and adapting designs to sizes and channels.
- **Checking work:** region zoom to 400%, before/after comparison, measurements like Photoshop's Histogram and Info panels (`canvas_inspect`), and a layout preflight.

## Principles

- **Agent-first.** Agents change structured data through small, ID-addressed patches. There is no mouse emulation.
- **Non-destructive.** Source assets stay untouched. Every change is a patch in an event log, so every change can be undone and traced to its author.
- **The document IR is the product.** Renderers and file formats, PSD included, are backends that can be swapped out.
- **Lossless PSD round-trip.** PSD data Gesso can't render is kept as opaque blocks on import. Writing those blocks back unchanged is still to come; until then, PSD export warns when it drops them.
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
plugins/gesso        The Gesso plugin: the hosted server plus the skills, for Claude, Codex, Copilot and Cursor
docs/                Technical spec, install guide, hosting and listing kits
```

The marketplace files sit at the root: `.claude-plugin/marketplace.json` (Claude Code, Cowork and Copilot), `.cursor-plugin/marketplace.json`, `.agents/plugins/marketplace.json` (Codex), `gemini-extension.json`, and `server.json` for the official MCP Registry.

## Install

Full guide, including Claude Desktop, troubleshooting and landing-page copy: [docs/install.md](docs/install.md).

Add Gesso to Claude Code with one command. `npx` downloads and starts it; there is nothing to clone or build.

```sh
claude mcp add gesso -- npx -y gesso-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "gesso": { "command": "npx", "args": ["-y", "gesso-mcp"] } } }
```

Or install the Claude Desktop extension: download `gesso-<version>.mcpb` and double-click it. Desktop asks for a Gesso folder (default `~/Documents/Gesso`), where Gesso reads your images and fonts and writes its exports. Build it with `node packages/gesso-mcp/build-mcpb.mjs`.

Then ask for a design, for example: "Make a 1080×1350 poster that says Hello from Gesso, show me a preview, then export a PSD to out/." Assets and exports resolve relative to the folder Claude runs in. Requires Node 22 or later.

Or install the Gesso plugin, which connects to the free hosted server and adds the skills, with nothing to install: `/plugin marketplace add bolenX/gesso`, then `/plugin install gesso@gesso`. The same plugin works in Codex, the Copilot CLI and Cursor ([how](docs/install.md#the-gesso-plugin)).

To host Gesso for claude.ai or ChatGPT, run `npx -y gesso-mcp --hosted` (or the Dockerfile) behind HTTPS. Each user gets a private workspace and connector URL. See [docs/hosting.md](docs/hosting.md).

Working on Gesso itself? The repo's `.mcp.json` loads your local checkout as the `gesso` server in any Claude Code session opened here.

## Publishing gesso-mcp

GitHub publishes it: bump `version` in `packages/gesso-mcp/package.json`, run `node scripts/sync-plugin.mjs` to carry the version (and any skill changes) into the plugin and marketplace files, and merge to `main`. A `gesso-mcp-v*` tag or a manual run from the Actions tab also works. It signs in to npm with Trusted Publishing, set up once on npmjs.com (the package's **Settings › Trusted publishing**: GitHub Actions, `bolenX`, `gesso`, `publish.yml`), so there's no token to expire; an npm token in the `NPM_TOKEN` secret works as a fallback. It skips versions that are already published. Each new version is then listed in the official MCP Registry, with no secret needed.

The tests fail if the plugin is out of step with `skills/` or the version, so run the sync script after changing a skill too.

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
