# Landing page brief: Gesso 0.14.0

This brief is for the session that maintains the Gesso landing page. Use it as the source of truth when you update the site's copy.

**0.14.0 update:** Gesso now has every filter in Photoshop's Filter menu (121), and installs as a plugin. Update:
- **Features:** the Filters group (group 1): the whole Filter Gallery, Adaptive Wide Angle, Vanishing Point, Flame, Picture Frame, Tree, Relight and Color to Alpha.
- **Numbers:** 121 filters (was 74).
- **Install section:** a Plugin tab or line, with the install commands from [install.md](install.md#the-gesso-plugin), and the one-click "Add to Cursor" and "Install in VS Code" links from [docs/listing/other-directories.md](listing/other-directories.md#install-links-for-the-website).
- **What's new:** add a 0.14.0 row.
- **Filenames:** use `gesso-0.14.0.mcpb` wherever a filename shows a version.

**0.13.0 update (still applies):** Gesso now has its own masking engine for hard cut-outs, and a cutouts skill. Update:
- **Features:** the Compositing points (group 3) and the cut-out check under Checking work (group 9).
- **Workflows:** add the cut-outs skill (group 7).
- **Numbers:** 31 skills and 56 recipes.
- **What's new:** add a 0.13.0 row.
- **Claims to avoid:** two new ones, under "What Gesso covers".

**0.12.0 update (still applies):** claude.ai and ChatGPT work, for free, through `https://mcp.gesso.run/mcp`. The two install cards use it (exact copy in [install.md](install.md), in the landing-page tabs table). Everything else below still applies.

Gesso 0.11.0 follows 0.10.0 on 25 October 2026. 0.10.0 added most of Photoshop's Filter, Image › Adjustments and Edit menus, every blend mode and layer style, retouching, and print output. 0.11.0 builds on that with:

- **Checking work:** the agent zooms into detail, compares before and after, and measures tones and colours like Photoshop's Histogram and Info panels. A preflight catches layout problems.
- **Skills, doubled:** 30 skills (was 15), and 51 tested recipes the agent applies in one step.
- **Selections:** Select and Mask (Refine Edge with Decontaminate Colors), Calculations, and Select Subject, Select Sky and face parts through the user's own AI tools.
- **Merging exposures:** Auto-Align and Auto-Blend Layers, for focus stacks and exposure brackets.
- **More stays live in Photoshop:** smart filters, corner-pinned and warped smart objects, and an embedded colour profile.
- **One AI plate for every size:** adapting a design to many sizes needs one background generation, not one per size.
- **Self-hosting:** a hosted mode for claude.ai and ChatGPT connectors, which people can run themselves.

If the site still has copy from before 0.10.0, it describes Gesso as a layout tool with PSD export. That undersells it: Gesso covers photo work too, including retouching, grading, compositing, filters and print. It now checks its own work as well.

Before you start, read the current site and compare it with this brief. Keep the install section from [install.md](install.md#for-the-landing-page); it is still correct, apart from the facts noted below.

## What to change

1. **Hero.** Keep the core promise: agents build layered images as data, and the files open in Photoshop as editable PSDs. Use the subhead to show the breadth (options below).
2. **Features.** Replace or extend the features section with the nine groups under [Feature groups](#feature-groups). "Checking work" (group 9) is new in 0.11, and groups 3, 5, 7 and 8 have new points.
3. **Workflows.** The workflows section covers the five photo niches, cut-outs, and design and adaptation skills (31 skills in all).
4. **"Opens in Photoshop."** Update the live and baked lists (see [What opens live in Photoshop](#what-opens-live-in-photoshop)). Some filters, distortions and warps are now live.
5. **Numbers.** Use the updated counts under [Numbers you can quote](#numbers-you-can-quote): 21 tools, 31 skills and 56 recipes.
6. **Install section.** The extension is still about 62 MB. Use `gesso-0.14.0.mcpb` wherever the filename shows a version.
7. **Claims.** Remove or fix anything listed under [Claims to avoid](#claims-to-avoid). Several 0.10 caveats no longer apply: auto-align and auto-blend, Calculations, and live smart filters.

## Release facts

| Fact | Value |
| --- | --- |
| Version | 0.14.0, the `latest` tag of `gesso-mcp` on npm |
| Claude Code | `claude mcp add gesso -- npx -y gesso-mcp` |
| Other agents | Every config runs `npx -y gesso-mcp` and needs Node 22 or later |
| Claude Desktop extension | `gesso-0.14.0.mcpb`, about 62 MB. Nothing else to install. |
| claude.ai and ChatGPT | `https://mcp.gesso.run/mcp` as a custom connector (claude.ai) or a developer-mode app with OAuth (ChatGPT). Free, no account, nothing to install. Or `npx -y gesso-mcp --tunnel` to run it on your own computer. |
| Platforms | macOS (Apple silicon and Intel), Windows, Linux |
| Agent tools | 21 |
| Bundled skills | 31, with 56 recipes |
| Licence | Apache-2.0, open source |
| Repository | `github.com/bolenX/gesso`, **public**. Link to it from the hero or footer. |
| Cost | Gesso is free. It never calls or pays for an image model: generative jobs go to the user's own connected tools. |

**Download button.** Link it to `https://github.com/bolenX/gesso/releases/latest/download/gesso.mcpb`. Every release attaches the extension under that name, so the link always gives the newest version, and it works for every visitor now the repo is public. There's no need to host the `.mcpb` with the site.

**Open source.** Now that the repo is public, the site can link to the source, the [changelog](../CHANGELOG.md) and the issues page, and invite contributions.

## Positioning

**One-liner (unchanged):** Gesso is an open-source, headless, agent-first image engine: "Remotion for Photoshop".

**What changed in the story:** Gesso was a design engine: posters, social sizes, text, shapes and gradients, with PSD export. 0.10 gave the agent most of a Photoshop retoucher's toolbox as well. 0.11 lets it check its own work: it zooms in, compares before and after, and measures, rather than eyeballing a preview. The agent works the way Gesso always has: structured, reversible edits to named layers.

**Headline options:**

- Your agent designs, retouches and grades, and checks its own work. You open the layers.
- Your agent designs, retouches and grades. You open the layers.
- Photo editing for agents, in layers you can still edit.
- The image engine for agents. Every result opens in Photoshop.

**Subhead options:**

- Filters, adjustment layers, blend modes, layer styles, masks, retouching and print output, all as non-destructive layers. Every result opens in Photoshop as a layered PSD.
- 121 filters, all 16 adjustment layers, 27 blend modes and every layer style, for any agent that speaks MCP. Open the result in Photoshop and keep editing.
- Select and Mask, Auto-Blend, frequency separation and 51 tested recipes, with an agent that measures its own results. Every layer opens in Photoshop.

## Feature groups

Each group has a heading, a line of copy and the points to show. Use Photoshop's own feature names: that is what visitors will search for.

### 1. Filters

**The whole Filter menu, as smart filters.**

Every filter in Photoshop's Filter menu, 121 in all, the whole Filter Gallery included. Each one stays editable on its layer, with Fade (opacity and blend mode), so changing a setting later re-renders the result.

- **Blur and Blur Gallery:** Gaussian, box, smart and surface blur; lens blur with depth maps; motion, radial and shape blur; field, iris, tilt-shift, path and spin blur.
- **Distort and perspective:** displace, Liquify, Puppet Warp, Lens Correction, Adaptive Wide Angle (fisheye, wide-angle and 360° panoramas), Vanishing Point (clone and paste in perspective), spherize, pinch, twirl, wave, ripple, zigzag, shear, polar coordinates, glass, ocean ripple, diffuse glow.
- **Noise:** add noise, reduce noise, despeckle, dust & scratches, median.
- **Pixelate:** colour halftone, crystallize, facet, fragment, mezzotint, mosaic, pointillize.
- **Render:** flame, picture frame, tree, relight, clouds, difference clouds, fibres, lens flare, lighting effects.
- **Sharpen:** sharpen and unsharp mask, smart sharpen, sharpen edges, and high-pass from Other.
- **Stylize:** oil paint, emboss, extrude, find edges, glowing edges, solarize, tiles, trace contour, wind, diffuse.
- **Filter Gallery, all 47:** Artistic (coloured pencil, dry brush, film grain, fresco, neon glow, paint daubs, palette knife, plastic wrap, rough pastels, smudge stick, sponge, underpainting, watercolour, cutout, poster edges), Brush Strokes (accented edges, angled strokes, crosshatch, dark strokes, ink outlines, spatter, sprayed strokes, sumi-e), Sketch (bas relief, chalk & charcoal, charcoal, chrome, Conté crayon, graphic pen, halftone pattern, note paper, photocopy, plaster, reticulation, stamp, torn edges, water paper), Texture (craquelure, grain, mosaic tiles, patchwork, stained glass, texturizer), plus glass, ocean ripple, diffuse glow and glowing edges. The Sketch filters draw in any two colours.
- **Video and Other:** de-interlace, NTSC colours, custom kernels, HSB/HSL, maximum, minimum, offset, Color to Alpha (drop white paper out of scans and sketches).
- **Camera Raw:** exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, vibrance, saturation, clarity, texture, dehaze, vignette, grain.

### 2. Adjustments

**Every adjustment layer.**

All 16 of Photoshop's adjustment layers stay live, including in the exported PSD:

Brightness/Contrast, Levels, Curves, Exposure, Vibrance, Hue/Saturation, Colour Balance, Black & White, Photo Filter, Channel Mixer, Colour Lookup (`.cube` LUTs), Invert, Posterize, Threshold, Gradient Map and Selective Colour.

Image › Adjustments commands are also included: Shadows/Highlights, Desaturate, Equalize, Match Colour and Replace Colour.

### 3. Compositing

**Blend like a compositor.**

- **Blend modes:** all 27, including Dissolve, Linear Burn and Dodge, Vivid, Linear and Pin Light, Hard Mix, Darker and Lighter Colour, Subtract and Divide.
- **Blend If:** This Layer and Underlying Layer, with split sliders.
- **Masks:** luminosity masks, colour range, channel masks and Calculations, alongside pixel and vector masks, clipping masks and groups. Masks recompute as the layers under them change.
- **Select and Mask:** Refine Edge solves each edge pixel's opacity from the photo itself (matting), so hair and fur come through strand by strand. Smart Radius keeps hard edges crisp next to soft ones. Decontaminate Colors gives each strand its own colour back, without the old background's.
- **Cut-outs without AI:** a studio-backdrop key that handles lighting falloff, a clean-plate key, choke and spread (Photoshop's Minimum and Maximum on a mask), and saturation masks.
- **Selections from AI:** Select Subject, Select Sky, and face parts (skin, eyes, lips, hair) as masks, made by the user's own segmentation tool. A mask made on a photo follows that photo wherever it's used.
- **Layer styles:** all ten of Photoshop's: drop shadow, inner shadow, outer glow, inner glow, bevel & emboss, satin, colour overlay, gradient overlay, pattern overlay and stroke. Gesso adds a background blur for frosted glass.

### 4. Shapes, type and transforms

**Shape it, bend it, put it in perspective.**

- **Boolean shapes:** unite, subtract, intersect, exclude.
- **Free transform:** rotate, flip, skew, distort, perspective (four-corner pin), warp mesh.
- **Type:** live text, and text on a path.
- **Gradients:** linear, radial and mesh gradients.
- **Smart objects:** edit a symbol once and every placement updates. They open in Photoshop as embedded smart objects.

### 5. Retouching

**Clean up without touching the original.**

- **Content-aware tools:** content-aware fill, spot healing and clone stamp, stored as editable spots on the layer rather than painted pixels. They keep the surrounding grain and texture.
- **Content-aware scale:** change an image's aspect ratio while keeping its subject intact.
- **Auto-Align and Auto-Blend:** line up frames shot from the same spot, then merge a focus stack into one sharp image, or exposure brackets into one even exposure. The result is ordinary layers with masks you can adjust.
- **Recipes in the skills:** frequency separation that rebuilds the original closely, dodge & burn with brush-like strokes, liquify and skin work.

### 6. Print and production

**Ready for the printer and the team.**

- **Exports:** PNG, JPEG, WebP, TIFF, layered PSD, SVG, and print PDF with bleed, crop marks and page sizes.
- **Colour:** RGB, or CMYK with ICC profiles. Soft-proof a preview against a print profile before you export.
- **Slices:** name layers like files (`logo.png`, `200% hero.jpg`, `512x512 icon.png`) and export them all in one step, like Photoshop's Generate › Image Assets.
- **Batch:** run a document as a template over a folder of images, or over rows of data for catalogues and personalised cards.
- **Merging:** stamp visible, copy merged, merge and rasterize.
- **Find and replace** text across a document, and duplicate layers.
- **Adapt sizes:** one design adapted to stories, squares, landscapes and banners, each laid out for its own size.

### 7. Workflows

**Skills that carry the craft.**

The engine makes an edit possible; the bundled skills make it good. Gesso ships 31 skills that teach the agent how professionals use these tools. Each has checks for the agent to run on its result. Most have **recipes**: proven layer setups (a frequency separation, a flambient stack, a duotone, a contact shadow, see-through glass) that the agent applies in one step and then fine-tunes. All 56 recipes are tested against sample photos, with measurements, on every change to Gesso.

Five of the skills cover 50 professional workflows, ten per niche:

| Niche | Workflows |
| --- | --- |
| Beauty and editorial | Skin clean-up, micro smoothing, contour sculpting, eyes, hair, makeup, wardrobe creases, cinematic grading, high-end sharpening, print proofing |
| Product and e-commerce | Cut-outs, focus stacking, multi-plate composites, de-speckling, symmetry, label wrap, contact shadows, glass cut-outs, ghost mannequins, batch catalogue output |
| Architecture and real estate | Flambient blending, vertical correction, window views, colour casts, sky replacement, de-cluttering, lawns, day to twilight, floor reflections, HDR-style interiors |
| Photo manipulation and digital art | Key visual composites, relighting, edge integration, atmospheric depth, texture mapping, particles and FX, silhouettes, palette harmonising, perspective matching, fantasy grading |
| Restoration and archival | Damage assessment, cracks and tears, missing parts, moiré, grain, colourising, faded contrast, stains, glass and emulsion damage, archival TIFF masters |

The other 26 skills:

- **Cut-outs:** hair and fur, studio shots, smoke and powder, and glass rebuilt from blend modes so it stays see-through on any background, with its refraction, shadow and caustic.
- **Graphic design:** poster composition, typography hierarchy, layout grids, brand application, duotone and double exposure.
- **Adapting and campaigns:** adapt sizes, extreme-ratio relayout, typography reflow, social campaign sets, channel packs, safe zones, right-to-left localisation, resolution adaptation, data-driven variants and clean plates.
- **Core techniques:** maps 50 core Photoshop techniques onto Gesso, from masking and dodge & burn to frequency separation, light wrap and soft proofing.
- **Reference skills:** filters, adjustments, compositing, retouching and production.
- **Effect recipes:** fractal glass, glass refraction and path blur.

### 8. Generative AI, on your own tools

**Bring your own image model.**

Gesso prepares jobs for the image tools the user already has connected:

- **Jobs:** expand (generative expand), generate, Generative Fill with regions, background removal, upscale, and selections: Select Subject, Select Sky, and face parts like skin, eyes and lips.
- **One plate for every size:** adapting a design to a story, a square and a banner needs a single expand, shared by every size, so the background matches across the set.
- **Results:** they come back into the document as layers and masks, with a record of what made them.

Gesso itself never calls or pays for a model.

### 9. Checking work (new in 0.11)

**An agent that looks closely.**

- **Zoom:** render any region at up to 400%, pixel for pixel, to check edges, skin and seams.
- **Before and after:** compare with an earlier version, side by side or as a difference image, with how much changed and where.
- **Measure:** histogram, clipping, colour cast, saturation, sharpness, noise, and an eyedropper with skin-tone checks, like Photoshop's Histogram and Info panels.
- **Preflight:** flags text in a platform's safe zones, type too small to read, enlarged images, and hidden or empty layers.
- **Cut-out check (new in 0.13):** measures a cut-out's halo of old background, its edge width, leftover specks and holes, and shows it over black, white and red.

## How it works (unchanged)

1. The agent reads the document as a compact outline of artboards and layers.
2. It changes the document with small patches addressed to layer IDs. Every change is a revision you can undo.
3. It renders a preview to check its work, zooming in and measuring where detail matters.
4. It exports the files to your Gesso folder.

In Claude Desktop the steps show as cards: the outline, the layers that changed, the preview, and the files with download buttons.

## What opens live in Photoshop

For a section titled something like "Open it in Photoshop". Suggested copy:

> Most of it stays live in Photoshop: adjustment layers, layer styles, text, shapes, and common filters as smart filters. What Photoshop can't match arrives baked into its own layer, so the file always looks the way Gesso rendered it.

**Live in the PSD:**

- artboards and text
- shape layers with vector masks, strokes with their caps and corners
- all 16 adjustment layers, including LUTs
- layer styles, blend modes and Blend If
- masks, clipping and groups
- smart objects
- smart filters, for 25 filters Photoshop has in the same form: Gaussian, Box, Motion and Surface Blur, Unsharp Mask, High Pass, Median, Dust & Scratches, Emboss, Mosaic, Twirl, Pinch, Spherize, Polar Coordinates, Offset and more. They keep their Fade opacity and blend mode.
- distorted and warped layers, as smart objects with Photoshop's own corner pin or custom warp, so the art inside stays editable
- an embedded sRGB colour profile

**Baked into pixels (each still on its own layer):**

- other filters, and layers that mix them with the ones above, including retouching spots
- text on a path
- pattern overlays, written as a clipped layer
- background blur
- luminosity, colour-range, channel and Calculations masks, refined edges, and AI selections, written as ordinary pixel masks

## Claims to avoid

**What Gesso covers:**

- Don't say Gesso has "every Photoshop feature". Say "most of Photoshop's Filter, Adjustments and Edit menus" or use the counts below.
- Don't say every filter stays live in Photoshop. 25 export as live smart filters; the rest are live in Gesso and baked in the PSD.
- Don't promise a lossless PSD round trip yet. When Gesso writes an imported PSD back out, it drops data it couldn't read, and it warns when it does.
- Don't call Gesso's cut-outs "AI background removal". The matting and keys are Gesso's own maths and run anywhere. AI selections still come from the user's own tools.
- Don't promise perfect hair on any background. Hair against a busy background of a similar colour is still hard, and the skill says so. Painting new fur strands with a brush isn't possible yet.

**Features Gesso doesn't have:**

- No brush or eraser painting, 3D, video timeline, Actions or plugins. Batch runs cover many jobs people use Actions for.
- No Photomerge (panorama stitching). Auto-Align and Auto-Blend handle frames shot from the same spot, not panoramas.
- No FFT filter, Lab mode or knockouts. The skills give workarounds.
- No 16-bit editing: Gesso works in 8 bits per channel.
- No Neural Filters or built-in AI. Generative work and AI selections (Select Subject, Select Sky) go to the user's own tools. Without one connected, the skills fall back on channel, colour-range and luminosity masks.
- Don't say Gesso matches Photoshop pixel for pixel. A reference kit measures how close each adjustment, blend mode, style and filter comes to Photoshop. Publish its results once it has been run against real Photoshop exports.

**Elsewhere:**

- claude.ai and ChatGPT connect to `https://mcp.gesso.run/mcp`, with nothing to install, or to the user's own computer with `npx -y gesso-mcp --tunnel`. Both are free. Say "connect with a custom connector", not "official integration": Gesso isn't in the Claude or ChatGPT directories yet.
- Rendering runs on the CPU, so don't claim real-time speed.
- Gesso isn't affiliated with Adobe. Use "Photoshop" to describe compatibility and feature names, not as part of Gesso's brand, and consider a footer line: "Photoshop is a trademark of Adobe Inc. Gesso is not affiliated with or endorsed by Adobe."

## Numbers you can quote

| Number | What it counts |
| --- | --- |
| 121 | Filter-menu filters: the whole menu, Filter Gallery included. With the 5 Image › Adjustments commands and 3 retouching tools on the same filter stack, there are 129 filter kinds. |
| 16 | Adjustment layers: all of Photoshop's |
| 27 | Blend modes |
| 10 | Photoshop layer styles, plus background blur |
| 7 | Export formats: PNG, JPEG, WebP, TIFF, PSD, SVG, PDF |
| 25 | Filters that open in Photoshop as live smart filters |
| 21 | Agent tools |
| 31 | Skills |
| 56 | Recipes, each tested against sample photos |
| 50 + 50 | 50 professional workflows and 50 core techniques |
| 400% | Deepest region zoom |

## Suggested page order

1. Hero
2. How it works (4 steps)
3. Feature grid: 9 cards, one per group above (or 8, with "Checking work" as its own band under How it works)
4. Workflows by niche: 5 cards
5. Open it in Photoshop: live vs baked
6. Install (existing section)
7. Open source, bring your own AI, and the footer with the trademark line

## What's new strip

If the site has a changelog or "What's new" strip:

| Version | What's in it |
| --- | --- |
| **0.14.0** | Every filter in Photoshop's Filter menu: the whole Filter Gallery (Artistic, Brush Strokes, Sketch in any two colours, Texture), Adaptive Wide Angle, Vanishing Point, Flame, Picture Frame, Tree, Relight and Color to Alpha, for 121 filters. The Gesso plugin for Claude, ChatGPT and Codex, Copilot and Cursor, and a listing in the official MCP Registry |
| 0.13.0 | A masking engine for hard cut-outs: hair solved strand by strand, Smart Radius, studio-backdrop and clean-plate keys, choke and spread, and a cut-out check. A cutouts skill, including see-through glass rebuilt from blend modes. Fixes for hosted servers: download links in claude.ai, no server paths in results, open-licence fonts only |
| 0.12.0 | claude.ai and ChatGPT, free: connect to `https://mcp.gesso.run/mcp`, or run Gesso on your own computer with `npx -y gesso-mcp --tunnel` (with a pairing code, so only you can connect). Behind it: OAuth sign-in, worker processes and abuse limits |
| 0.11.0 | Zoom, compare and measure, preflight, 30 skills with 51 tested recipes, Select and Mask, Calculations, Auto-Align and Auto-Blend, AI selections (subject, sky, face parts) on your own tools, one expand for every size, live smart filters and warps in the PSD, self-hosting |
| 0.10.0 | Photoshop's Filter menu as smart filters, every adjustment layer, all blend modes and layer styles, Blend If and computed masks, boolean shapes and free transform, content-aware fill, healing and cloning, TIFF and CMYK export, slices, batch runs, and 11 workflow skills |
| 0.9.0 | SVG export, print PDF with bleed and crop marks, text on a path, more filters (radial blur, noise, sharpen, twirl, wave, shear, pixelate) |
| 0.8.0 | Glass refraction, path blur, motion blur |
| 0.7.0 | Gradient maps, mesh gradients |
