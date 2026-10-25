# Changelog

Versions of `gesso-mcp`, the npm package and Claude Desktop extension. Each version's notes become its GitHub release.

## Unreleased

- **Skills:**
  - 15 new skills: duotone, double exposure, poster composition, typography hierarchy, layout grids, brand application, clean plates, typography reflow, social campaign sets, channel packs, safe zones, extreme-ratio relayout, RTL localisation, resolution adaptation, and data-driven variants.
  - Every skill has a `checks.md`.
  - 21 skills have recipes (51 in all): proven layer setups that the new `skill_apply` tool fills in and applies as one revision. `skill_read` lists them.
  - Each recipe has an example, which applies it to a synthetic photo and checks the result with measurements in the test suite.
- **Preflight:** `canvas_inspect` with `preflight: true` lists:
  - text and logos in a preset's safe zones or off the artboard
  - type too small for the format
  - images enlarged past their pixels
  - hidden or empty layers
- **Patches:**
  - `set` paths take list indexes and `+` to append, e.g. `filters.+` adds a filter and `filters.0.radius` tunes one.
  - The `*` selector matches every layer.
- **Retouching:**
  - Content-aware fill and healing keep the surrounding grain and texture instead of smoothing it. Before, they kept 60–75% of it; now 95–100%.
  - High Pass uses the same blur as Gaussian Blur, as in Photoshop, so frequency separation rebuilds the original exactly.
  - High Pass has a new `scale` option for 8-bit frequency separation.
- **Seeing detail:** `canvas_render` zooms into a region at up to 400%, pixel for pixel, and compares with an earlier revision or with layers hidden. The comparison is side by side or as a difference image, with the share of pixels changed, ΔE and where the changes are.
- **Measuring:** the new `canvas_inspect` tool works like Photoshop's Histogram and Info panels. It reports tonal range, clipping per channel, contrast, colour cast, chroma, sharpness and noise. Its eyedropper gives hex, RGB, HSB, Lab and the vectorscope angle against the skin-tone line. It also returns clipping and sharpness maps. It can measure a region, some layers on their own, or an earlier revision.
- **Photoshop reference kit** (`reference/`): 73 cases (adjustments, blend modes, layer styles and filters) to render in Photoshop. A test scores Gesso against those exports in ΔE, writes a report, and fails if a case gets worse.
- **Hosted Gesso** for claude.ai and ChatGPT connectors: `gesso-mcp --hosted` gives every user a private workspace, with a connector URL, an upload page, and download links for exports. Tools stay inside their own workspace, downloads only reach public addresses, renders are size-limited, and idle workspaces are deleted. There's a Dockerfile and a hosting guide.
- **Local HTTP** (`--http`) now listens on 127.0.0.1 only, and its download buttons work across requests.
- **Releases:** every version gets a GitHub release with the Claude Desktop extension attached, under its versioned name and as `gesso.mcpb`.
- **Slices:** layer names can't write outside the export folder.

## 0.10.0 (2026-10-25)

- **Filters:** Photoshop's Filter menu as smart filters with Fade: Blur and Blur Gallery, Distort, Noise, Pixelate, Render, Sharpen, Stylize, Video and Other, plus Camera Raw, Liquify, Puppet Warp and Lens Correction.
- **Adjustments:** all 16 adjustment layers, including Colour Lookup with `.cube` LUTs, plus Shadows/Highlights, Desaturate, Equalize, Match Colour and Replace Colour.
- **Compositing:** all 27 blend modes, Blend If, and luminosity, colour-range and channel masks.
- **Layer styles:** all ten of Photoshop's layer styles.
- **Shapes and transforms:** boolean shapes, skew, distort, perspective and warp.
- **Retouching:** content-aware fill, healing, clone stamp and content-aware scale.
- **Production:** TIFF and CMYK export with ICC profiles, soft proofing, slices, `canvas_stamp` (stamp visible, merge, rasterize), `canvas_batch` (templates over images or data rows), and find and replace.
- **Skills:** 11 new skills: references for filters, adjustments, compositing, retouching and production, 50 core techniques, and 50 workflows for beauty, product, real estate, photo manipulation and restoration.

## 0.9.0

- SVG export.
- Print PDF with bleed, crop marks and page sizes.
- Text on a path.
- Radial blur, noise, sharpen, twirl, wave, shear and pixelate filters.

## 0.8.0

Glass refraction, path blur and motion blur.

## 0.7.0

Gradient maps and mesh gradients.

## 0.6.0

Background blur, fill opacity and the fractal-glass recipe.

## 0.5.1

Large documents no longer time out on export.

## 0.5.0

- **Documents:** saved to the Gesso folder and listed with `canvas_list`.
- **Layers:** rotation and flips.
- **Tools:**
  - `font_list` finds installed fonts.
  - `asset_import` adds images and fonts from a path, URL or data.
  - `artboard_create` adds sizes from presets, with the adapt-sizes skill.
  - `gen_prepare` prepares jobs for the user's image tools.
  - `psd_import` opens a PSD as an editable document.
- **PSD export:** live vector shapes and layer effects.
- **Text:** mixed styling within a text layer, with runs.
- **Reliability:** golden render tests and a decoded-image cache.

## 0.4.0 and earlier

- **0.4.0:** plain layers are drawn within their own bounds.
- **0.3.x:**
  - the Claude Desktop extension and `GESSO_WORKDIR`
  - install steps for more agents
  - teaching agents the document format
  - large-PSD export fixes
- **0.2.0:** exports as file cards with download buttons.
- **0.1.0:** the first npm release. It has the document format, patches with history, rendering, PSD export with artboards, live text, shapes, adjustments and smart objects.
