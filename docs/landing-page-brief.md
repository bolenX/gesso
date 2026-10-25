# Landing page brief: Gesso 0.10.0

This brief is for the session that maintains the Gesso landing page. Use it as the source of truth when you update the site's copy.

Gesso 0.10.0 shipped on 25 October 2026. It is the biggest release so far, adding:

- most of Photoshop's Filter, Image › Adjustments and Edit menus
- every blend mode and layer style
- retouching tools
- print and production output
- 11 new workflow skills

Copy written before this release describes Gesso as a layout tool with PSD export. That undersells it: Gesso now covers photo work too, including retouching, grading, compositing, filters and print.

Before you start, read the current site and compare it with this brief. Keep the install section from [install.md](install.md#for-the-landing-page); it is still correct, apart from the two facts noted below.

## What to change

1. **Hero.** Keep the core promise: agents build layered images as data, and the files open in Photoshop as editable PSDs. Use the subhead to show the new breadth (options below).
2. **Features.** Replace or extend the features section with the eight groups under [Feature groups](#feature-groups).
3. **Workflows.** Add a section for the five professional niches the skills cover.
4. **"Opens in Photoshop."** Say plainly what stays live in the PSD and what arrives as pixels (see [What opens live in Photoshop](#what-opens-live-in-photoshop)).
5. **Exports.** Add TIFF, CMYK with ICC profiles, soft proofing, slices and batch runs. SVG and print PDF arrived in 0.9.
6. **Install section.** Update the extension size to about 62 MB (it was 55 MB), and use `gesso-0.10.0.mcpb` wherever the filename shows a version.
7. **Claims.** Remove or fix anything listed under [Claims to avoid](#claims-to-avoid).

## Release facts

| Fact | Value |
| --- | --- |
| Version | 0.10.0, the `latest` tag of `gesso-mcp` on npm |
| Claude Code | `claude mcp add gesso -- npx -y gesso-mcp` |
| Other agents | Every config runs `npx -y gesso-mcp` and needs Node 22 or later |
| Claude Desktop extension | `gesso-0.10.0.mcpb`, about 62 MB. Nothing else to install. |
| Platforms | macOS (Apple silicon and Intel), Windows, Linux |
| Agent tools | 17 |
| Bundled skills | 15 |
| Licence | Apache-2.0, open source |
| Repository | `github.com/bolenX/gesso`, still **private** |
| Cost | Gesso is free. It never calls or pays for an image model: generative jobs go to the user's own connected tools. |

**Download button.** No GitHub release exists yet and the repo is private, so `https://github.com/bolenX/gesso/releases/latest/download/gesso-0.10.0.mcpb` would fail for visitors. Until the repo is public with a release attached, host the `.mcpb` with the site (outside its git repo). If you can't do either, tell the user rather than shipping a broken link.

## Positioning

**One-liner (unchanged):** Gesso is an open-source, headless, agent-first image engine: "Remotion for Photoshop".

**What changed in the story:** Gesso was a design engine: posters, social sizes, text, shapes and gradients, with PSD export. It now gives an agent most of a Photoshop retoucher's toolbox as well. The agent works the way Gesso always has: structured, reversible edits to named layers, with a rendered preview to check each step.

**Headline options:**

- Your agent designs, retouches and grades. You open the layers.
- Photo editing for agents, in layers you can still edit.
- The image engine for agents. Every result opens in Photoshop.

**Subhead options:**

- Filters, adjustment layers, blend modes, layer styles, masks, retouching and print output, all as non-destructive layers. Every result opens in Photoshop as a layered PSD.
- 74 filters, all 16 adjustment layers, 27 blend modes and every layer style, for any agent that speaks MCP. Open the result in Photoshop and keep editing.

## Feature groups

Each group has a heading, a line of copy and the points to show. Use Photoshop's own feature names: that is what visitors will search for.

### 1. Filters

**The Filter menu, as smart filters.**

74 of Photoshop's filters. Each one stays editable on its layer, with Fade (opacity and blend mode), so changing a setting later re-renders the result.

- **Blur and Blur Gallery:** Gaussian, box, smart and surface blur; lens blur with depth maps; motion, radial and shape blur; field, iris, tilt-shift, path and spin blur.
- **Distort:** displace, Liquify, Puppet Warp, Lens Correction, spherize, pinch, twirl, wave, ripple, zigzag, shear, polar coordinates, glass, ocean ripple, diffuse glow.
- **Noise:** add noise, reduce noise, despeckle, dust & scratches, median.
- **Pixelate:** colour halftone, crystallize, facet, fragment, mezzotint, mosaic, pointillize.
- **Render:** clouds, difference clouds, fibres, lens flare, lighting effects.
- **Sharpen:** sharpen and unsharp mask, smart sharpen, sharpen edges, and high-pass from Other.
- **Stylize:** oil paint, emboss, extrude, find edges, glowing edges, solarize, tiles, trace contour, wind, diffuse.
- **Filter Gallery:** cutout, poster edges, halftone pattern.
- **Video and Other:** de-interlace, NTSC colours, custom kernels, HSB/HSL, maximum, minimum, offset.
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
- **Masks:** luminosity masks, colour range and channel masks, alongside pixel and vector masks, clipping masks and groups.
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

- **Content-aware tools:** content-aware fill, spot healing and clone stamp, stored as editable spots on the layer rather than painted pixels.
- **Content-aware scale:** change an image's aspect ratio while keeping its subject intact.
- **Recipes in the skills:** frequency separation, dodge & burn, liquify and skin work.

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

The engine makes an edit possible; the bundled skills make it good. Gesso ships 15 skills that teach the agent how professionals use these tools. Five of them cover 50 professional workflows, ten per niche:

| Niche | Workflows |
| --- | --- |
| Beauty and editorial | Skin clean-up, micro smoothing, contour sculpting, eyes, hair, makeup, wardrobe creases, cinematic grading, high-end sharpening, print proofing |
| Product and e-commerce | Cut-outs, focus stacking, multi-plate composites, de-speckling, symmetry, label wrap, contact shadows, glass cut-outs, ghost mannequins, batch catalogue output |
| Architecture and real estate | Flambient blending, vertical correction, window views, colour casts, sky replacement, de-cluttering, lawns, day to twilight, floor reflections, HDR-style interiors |
| Photo manipulation and digital art | Key visual composites, relighting, edge integration, atmospheric depth, texture mapping, particles and FX, silhouettes, palette harmonising, perspective matching, fantasy grading |
| Restoration and archival | Damage assessment, cracks and tears, missing parts, moiré, grain, colourising, faded contrast, stains, glass and emulsion damage, archival TIFF masters |

The other ten skills:

- **Core techniques:** maps 50 core Photoshop techniques onto Gesso, from masking and dodge & burn to frequency separation, light wrap and soft proofing.
- **Reference skills:** filters, adjustments, compositing, retouching and production.
- **Effect recipes:** adapt sizes, fractal glass, glass refraction and path blur.

### 8. Generative AI, on your own tools

**Bring your own image model.**

Gesso prepares jobs for the image tools the user already has connected:

- **Jobs:** expand (generative expand), generate, Generative Fill with regions, background removal and upscale.
- **Results:** they come back into the document as layers, with a record of what made them.

Gesso itself never calls or pays for a model.

## How it works (unchanged)

1. The agent reads the document as a compact outline of artboards and layers.
2. It changes the document with small patches addressed to layer IDs. Every change is a revision you can undo.
3. It renders a preview to check its work.
4. It exports the files to your Gesso folder.

In Claude Desktop the steps show as cards: the outline, the layers that changed, the preview, and the files with download buttons.

## What opens live in Photoshop

For a section titled something like "Open it in Photoshop". Suggested copy:

> Most of it stays live in Photoshop. Filters and distortions arrive baked into their layer, so the file always looks the way Gesso rendered it.

**Live in the PSD:**

- artboards and text
- shape layers with vector masks
- all 16 adjustment layers, including LUTs
- layer styles, blend modes and Blend If
- masks, clipping and groups
- smart objects

**Baked into pixels (each still on its own layer):**

- smart filters, including retouching spots
- distorted and warped layers
- text on a path
- pattern overlays, written as a clipped layer
- background blur
- luminosity, colour-range and channel masks, written as ordinary pixel masks

## Claims to avoid

**What Gesso covers:**

- Don't say Gesso has "every Photoshop feature". Say "most of Photoshop's Filter, Adjustments and Edit menus" or use the counts below.
- Don't say smart filters stay live in Photoshop. They are live in Gesso and baked in the PSD.
- Don't promise a lossless PSD round trip yet. When Gesso writes an imported PSD back out, it drops data it couldn't read, and it warns when it does.

**Features Gesso doesn't have:**

- No brush or eraser painting, 3D, video timeline, Actions or plugins. Batch runs cover many jobs people use Actions for.
- No Photomerge, auto-align or auto-blend: focus stacking is done by hand with masks.
- No FFT filter, Lab mode, Calculations or knockouts. The skills give workarounds.
- No Neural Filters or built-in AI. Generative work goes to the user's own tools.

**Elsewhere:**

- claude.ai and ChatGPT are still "coming soon". Don't say they're supported.
- Rendering runs on the CPU, so don't claim real-time speed.
- Gesso isn't affiliated with Adobe. Use "Photoshop" to describe compatibility and feature names, not as part of Gesso's brand, and consider a footer line: "Photoshop is a trademark of Adobe Inc. Gesso is not affiliated with or endorsed by Adobe."

## Numbers you can quote

| Number | What it counts |
| --- | --- |
| 74 | Filter-menu filters. With the 5 Image › Adjustments commands and 3 retouching tools on the same filter stack, there are 82 filter kinds. |
| 16 | Adjustment layers: all of Photoshop's |
| 27 | Blend modes |
| 10 | Photoshop layer styles, plus background blur |
| 7 | Export formats: PNG, JPEG, WebP, TIFF, PSD, SVG, PDF |
| 17 | Agent tools |
| 15 | Skills |
| 50 + 50 | 50 professional workflows and 50 core techniques |

## Suggested page order

1. Hero
2. How it works (4 steps)
3. Feature grid: 8 cards, one per group above
4. Workflows by niche: 5 cards
5. Open it in Photoshop: live vs baked
6. Install (existing section)
7. Open source, bring your own AI, and the footer with the trademark line

## What's new strip

If the site has a changelog or "What's new" strip:

| Version | What's in it |
| --- | --- |
| **0.10.0** | Photoshop's Filter menu as smart filters, every adjustment layer, all blend modes and layer styles, Blend If and computed masks, boolean shapes and free transform, content-aware fill, healing and cloning, TIFF and CMYK export, slices, batch runs, and 11 workflow skills |
| 0.9.0 | SVG export, print PDF with bleed and crop marks, text on a path, more filters (radial blur, noise, sharpen, twirl, wave, shear, pixelate) |
| 0.8.0 | Glass refraction, path blur, motion blur |
| 0.7.0 | Gradient maps, mesh gradients |
