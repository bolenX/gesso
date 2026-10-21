# Agent-First Image Engine: Technical Spec v0.1

Oct 21, 2026 · @rameez

## Vision and principles

We are building an open-source, headless, agent-first image engine: "Remotion for Photoshop". Agents create and edit layered compositions as data, and every output opens in Photoshop as a fully editable PSD. The headless core ships first; a human-facing canvas UI follows as a client of the same API.

**Principles**

- **Agent-first.** Agents edit structured data through small, ID-addressed patches, never mouse emulation.
- **Non-destructive.** Source assets stay pristine. Every change is a patch in an event log, so everything is undoable and attributable.
- **The document IR is the product.** Renderers and file formats, including PSD, are replaceable backends.
- **Lossless PSD round-trip.** Never destroy what we can't render: unknown PSD data is preserved as opaque blocks and written back untouched.
- **Skills carry the craft.** The engine makes edits possible; bundled skills make them good.
- **The project never pays per generation.** Generative operations route to the user's own connected tools, keys or hardware.

**Scope reality check.** Full Photoshop parity is not a goal; it is 35 years of features. Every feature is assigned a tier and a support level instead.

| Tier | Features | Support |
| --- | --- | --- |
| Core (v0.1) | Artboards, layers, groups, masks, clipping, 16 standard blend modes, text, shapes, main adjustments, transforms | Render, edit, round-trip |
| Design (v0.2) | Layer styles, smart objects, smart filters, Photoshop-only blend modes | Render, edit, round-trip |
| Pixel (v0.3) | Brush, eraser, clone, heal as stored stroke data; mesh warp | Render, edit, round-trip |
| AI-native | Expand, fill, background removal, relight, upscale, segmentation, face parsing | Brokered to providers, stored as layers with provenance |
| Out of scope | 3D, video timeline, Actions, plugins, print separations | Preserved on round-trip, never rendered |

## Architecture

The system has three hard boundaries: the document IR, the evaluator, and the encoders. If the evaluator interface stays clean, a Rust/wgpu core can replace it later without breaking any agent built against v0.1.

**Decisions**

- **Engine: Skia via CanvasKit (Wasm), on the server and later in the browser.** One engine on both sides means the future UI preview is pixel-identical to export. Sharp (libvips) handles decode, resize, ICC colour management and encode. ag-psd writes and reads PSD.
- **Text: CanvasKit Paragraph API (HarfBuzz and ICU) from day one.** Basic `fillText` breaks Arabic joining and mixed-direction runs, and RTL is a planned skill.
- **Patches are the only way to change a document.** Agent edits and, later, human edits from the UI are the same patch format in the same event log, tagged by author. Undo, history and branching (variants) come from the log.
- **Selection is shared state.** `$selection` is reserved in the API from v0.1, so the UI slots in later with no API change.
- **Generation is brokered, never called by the engine.** The engine prepares provider-neutral job specs; the agent routes them (see Generative broker).

**Language and packaging:** TypeScript core, Zod as the single source of truth for runtime validation, JSON Schema and MCP tool schemas. Ships as an npm package, a Docker image and an MCP server.

**Why not Python and GEGL?** GEGL is the most correct non-destructive graph engine, but GObject introspection in Docker is painful and the agent tooling ecosystem is TypeScript-first. ML operations that need Python run as separate services behind the broker.

## Document schema

A document is an infinite canvas holding one or more artboards, with assets and linked smart objects shared at document level. Layer arrays run bottom to top, matching PSD.

**Design rules**

- Stable, meaningful IDs (`headline`, not `layer_17`). Agents address layers by ID, never by array index.
- Intent-based layout (anchor, margin, percentage size) alongside absolute boxes, so reflow across sizes works.
- Assets are referenced, never inlined, keeping the tree small enough for an agent's context.
- Semantic metadata (role, tags, description) is first-class, so agents understand layers without parsing coordinates.

```ts
type Doc = {
  id: string;
  revision: number;
  assets: Record<string, Asset>;
  symbols?: Record<string, SmartObject>;   // linked across artboards
  artboards: Artboard[];
  unknown?: OpaqueBlock[];                 // preserved PSD data we don't render
};

type Artboard = {
  id: string;                              // "story-9x16"
  name: string;
  frame: { x: number; y: number; w: number; h: number };
  preset?: string;                         // "instagram-story", "a4", "iab-300x600"
  background?: Paint;
  meta?: Meta;
  layers: Layer[];                         // bottom to top
};

type LayerBase = {
  id: string;
  name: string;
  meta?: Meta;                             // { role, tags, description, locked, provenance }
  visible?: boolean;
  opacity?: number;                        // 0..1
  blend?: BlendMode;
  clip?: boolean;                          // clips to nearest non-clipped layer below
  mask?: Mask;
  filters?: Filter[];                      // smart filters, before mask and blend
  frame: Frame;
};

type Frame =
  | { x: number; y: number; w: number; h: number }
  | { anchor: Anchor; margin?: number | [number, number]; w?: Len; h?: Len; aspect?: number };

type Layer = ImageLayer | ShapeLayer | TextLayer | AdjustmentLayer | GroupLayer;

type Mask =
  | { kind: "raster"; asset: string; invert?: boolean; feather?: number }
  | { kind: "vector"; shape: Shape; feather?: number }
  | { kind: "luminance-of"; layer: string };
```

**Layer types**

| Type | Key fields |
| --- | --- |
| `image` | `asset`, `fit` (cover, contain, fill), `focus` point for crops |
| `shape` | `rect` (with radius), `ellipse` or SVG `path`; `fill`, `stroke` |
| `text` | `content`, `style` (font, size, weight, tracking, leading, fill, align), `box` (point or area with shrink-to-fit), `direction` (ltr, rtl) |
| `adjustment` | brightness-contrast, hue-saturation, curves, levels (more in v0.2) |
| `group` | `children`, `isolation` (pass-through or isolate) |

**Roles** form a closed vocabulary: background, subject, product, container, logo, headline, body, cta, decoration, overlay, grade, generated-extension.

**The outline view** is what agents read by default, at roughly 20 to 40 tokens per layer:

```
promo-01  rev 12
▣ post-4x5  1080×1350
  ├ backdrop      shape   role=background
  ├ card          shape   role=container  [clip-base]
  │ ↳ card-photo  image   clip  multiply  "Model portrait, warm light"
  └ headline      text    role=headline  "Summer Edit"  bottom-left
▣ story-9x16  1080×1920
  └ …
```

## Rendering pipeline and layer interactions

A patch re-renders only the nodes it touches, because every render node is cached under a hash of its parameters and inputs.

1. **Validate:** schema check plus semantic checks (clip with no base, missing asset, edit to a locked layer, text overflow).
2. **Resolve:** fetch and hash assets, load fonts, convert intent frames into absolute boxes per artboard.
3. **Compile:** build the render DAG; each node's key is `hash(params + input keys)`.
4. **Evaluate:** skip cache hits; render the rest.
5. **Encode:** PNG, WebP or JPEG per artboard; PSD with artboards; manifest JSON sidecar.

**Compositing order within a group (bottom up)**

```
for each layer:
  surface = render content (padded if filters expand bounds)
  surface = apply smart filters in order
  surface = apply mask (raster alpha × vector coverage, feathered)

  if clip base:
      group = surface
      for each consecutive clipped layer above:
          s = render + filters + mask, then DESTINATION-IN base alpha
          composite s onto group with its blend and opacity
      composite group onto backdrop with the base's blend and opacity

  else if adjustment:
      adjusted = f(backdrop)               # everything below, in scope
      backdrop = lerp(backdrop, adjusted, opacity × mask)
      # clipped adjustment: also × base alpha

  else:
      composite surface onto backdrop with blend and opacity
```

**Rules that matter for Photoshop parity**

- **Blend in gamma-encoded space, not linear.** Photoshop blends RGB in document space by default; linear blending looks more physical but visibly mismatches the PSD.
- **Blend coverage:** Skia provides the 16 standard W3C/PDF modes. Linear burn, vivid light, linear light, pin light, hard mix, subtract, divide and darker or lighter colour need custom kernels (v0.2; linear light is required for frequency separation).
- **Pass-through groups** let adjustments inside see the backdrop outside; isolated groups composite onto transparency first.
- **Smart filters** are an ordered, parametric stack, one DAG node each, so changing a blur radius never re-decodes the source.
- **PSD writes both forms:** parametric data (live text, adjustment layers) plus our rendered pixels. Text layers are flagged for Photoshop to re-render on open.
- **Precision:** 8-bit RGBA in v0.1. Chained curves and levels band visibly at 8-bit, so a 16-bit or float path is planned.

## Agent interface

Agents work through a small MCP tool surface and edit with atomic, ID-addressed patches, never by rewriting the document.

| Tool | Purpose |
| --- | --- |
| `canvas_create` | New document from a spec or template; returns the outline |
| `canvas_outline` | Compact tree of artboards and layers; the agent's default read |
| `canvas_get` | Full JSON for specific selectors only |
| `canvas_selection` | Read or set the current selection (`$selection`) |
| `canvas_patch` | Apply atomic operations against a `baseRevision` |
| `canvas_render` | Preview at a scale, optional region; annotated mode outlines layers with an ID legend |
| `artboard_create` | New artboard from a preset or size; `duplicate` with reflow |
| `canvas_export` | PNG per artboard, PSD, manifest |
| `asset_import` | From URL or path; returns asset ID, size and an auto description |
| `canvas_history` | List revisions, revert, fork variants |
| `gen_prepare` | Build a provider-neutral generative job spec (see Generative broker) |

**Patch format**

```json
{
  "doc": "promo-01",
  "baseRevision": 12,
  "ops": [
    { "op": "set", "target": "#headline", "path": "content", "value": "Autumn Edit" },
    { "op": "set", "target": "#card-photo", "path": "opacity", "value": 0.8 },
    { "op": "set", "target": "$selection", "path": "style.fill", "value": "#E8572A", "many": true },
    { "op": "insert", "after": "#card-photo", "layer": { "id": "badge", "type": "shape" } },
    { "op": "move", "target": "#logo", "to": "top" },
    { "op": "remove", "target": "#old-badge" }
  ],
  "dryRun": false,
  "returnPreview": 0.25
}
```

**Rules**

- **Selectors:** `#id`, `@role`, `.tag`, `$selection`, optionally scoped by artboard (`story-9x16 #headline`). Matching more than one layer is an error unless the op sets `"many": true`.
- **Why not RFC 6902:** index paths like `/layers/3` break when siblings shift, and LLMs miscount. Ops are compiled to RFC 6902 internally for the event log.
- **Atomic:** all ops apply or none do.
- **Response:** new revision, changed IDs, warnings (for example text overflow), optional preview.
- **Conflicts:** a stale `baseRevision` returns the ops applied since, so the agent rebases instead of overwriting.
- **Macros later:** `align`, `fit-text`, `swap-asset` compile down to core ops.

## Generative broker

The engine never calls a generative model. It prepares a provider-neutral job, the agent routes it to whatever the user already has, and the result returns as an ordinary layer, so the project pays nothing per generation.

1. Agent calls `gen_prepare` (for example expand `story-9x16` to 1080×1920).
2. Engine returns a job spec: padded image, mask, target size, suggested prompt drawn from layer metadata.
3. Agent sends it to an available provider.
4. Agent calls `asset_import` on the result, then `canvas_patch` to insert it.
5. Engine places it with a feathered seam mask and records provenance.

```json
{
  "job": "expand",
  "artboard": "story-9x16",
  "source": "asset://render/story-9x16@rev14.png",
  "padded": "asset://jobs/exp-01/padded.png",
  "mask": "asset://jobs/exp-01/mask.png",
  "targetSize": [1080, 1920],
  "prompt": "continue the warm studio backdrop, soft floor shadow, no new objects",
  "negative": "text, logos, people",
  "seamFeather": 48
}
```

The engine produces both a padded canvas with mask and the plain source with target size, because providers differ in what they accept.

**Provider routes**

| Route | How it works | Who pays | Best for |
| --- | --- | --- | --- |
| Host MCPs | Skill tells the agent to use a connected expand or outpaint tool (for example Magnific or Higgsfield) | User's existing credits | Default, zero setup |
| BYOK | Thin adapters for direct APIs using the user's own key from an env variable | User's API account | Headless pipelines without an MCP host |
| Local | Optional GPU Docker service running an open model | Hardware only | Privacy, volume, offline |

**Job types:** expand (v0.1), segmentation (v0.1), inpaint for clean plates (v0.1), then fill, background removal, relight, upscale and face parsing.

**Provenance:** every generated result is a separate layer carrying `meta.provenance` (op, provider, model, prompt, seed, source revision). Originals are never touched, a different provider means replacing one layer, and the manifest supports AI-content disclosure.

**Cautions**

- Read each provider's terms before shipping an official adapter, especially commercial-use rights per tier. Several popular open fill models are non-commercial.
- Generated pixels are non-deterministic. Golden tests cover the plumbing (masks, seams, insertion, provenance); visual quality is judged by each skill's render-and-check loop.

## Skill catalogue

Twenty-four skills across four families ship in three waves, and each skill's required primitives set the engine roadmap. A skill is not a macro: it pairs a recipe with craft judgement and a visual check loop.

```
skills/<name>/
  SKILL.md       # when to use, workflow, judgement calls, failure modes
  recipe.json    # parameterised patch template
  checks.md      # what to verify in the render before finishing
  examples/      # before/after docs with golden renders
```

**Graphic design (v0.1)**

| Skill | Primitives |
| --- | --- |
| Layout and grid systems | Artboards, anchor frames, guides |
| Typography hierarchy | Text layers, tracking, leading, area text with fit |
| Social campaign set | Artboards, linked smart objects, reflow |
| Colour and brand application | Paint tokens, document swatches |
| Poster and editorial composition | Clipping, masks, blend modes |

**Adaptation**

| Skill | Wave | Primitives |
| --- | --- | --- |
| adapt-sizes (flagship) | v0.1 | Expand broker, segmentation, linked smart objects, anchors |
| channel-packs | v0.1 | Artboard presets, export profiles, file-size limits |
| safe-zone-compliance | v0.1 | Per-preset zone maps, render-loop validation |
| typography-reflow | v0.1 | Area text with fit, line-break control, minimum sizes |
| clean-plate | v0.1 | Segmentation, inpaint job |
| extreme-ratio-relayout | v0.2 | Layout variants per ratio class, group restructuring ops |
| rtl-localisation | v0.2 | HarfBuzz shaping, mirroring rules, font fallback, numeral style |
| resolution-adaptation | v0.2 | Upscale job, effective-DPI check |
| data-driven-variants | v0.2 | Data binding on text and image layers, batch export |

**Photo manipulation (v0.2)**

| Skill | New primitives |
| --- | --- |
| Compositing and cut-outs | Segmentation masks, feathering, refine edge |
| Colour grading and matching | Curves, levels, selective colour, gradient map, LUTs |
| Light and shadow integration | Layer styles, blurred-shadow shapes |
| Double exposure, duotone, stylised | Gradient maps, Photoshop-only blend modes |
| Background extension and generative fill | Fill and outpaint jobs with provenance |

**High-end retouching (v0.3)**

| Skill | New primitives |
| --- | --- |
| Frequency separation | Gaussian blur filter, Apply Image (subtract, offset 128), linear light |
| Dodge and burn | 50% grey soft light layers, stroke data, luminosity helpers |
| Skin cleanup and healing | Blemish detection, inpaint on masks |
| Face-parsed adjustments | Face parsing masks (skin, eyes, lips, hair, brows) |
| Liquify and shape refinement | Mesh warp layer with stored displacement |

**Retouching constraint:** agents cannot brush precisely by coordinates, so retouching works as detect, mask, apply parametric operations, then check at 100% crops. Position it as a fast first pass to roughly 85%, with a human finishing pass.

**Authoring:** craft knowledge is the scarce input. The SKILL.md workflows, retouching included, should be written by a senior practitioner while the engine is being built.

## Adaptation pipeline

Adaptation crops as much as the subject allows and generates only the remainder, once, as a shared plate every size crops from. Expanding per size would give each artboard a different background and multiply cost.

1. **Analyse:** focal point, subject mask (segmentation), platform safe zones.
2. **Plan:** per target, scale, then crop budget, then the remaining deficit per axis.
3. **Union:** the super canvas is the bounding box of all deficits.
4. **Clean plate (optional):** inpaint the subject out so expansion never echoes the product at the edges.
5. **Generate:** one expand job via the broker; staged in steps when expansion exceeds roughly 50% per side.
6. **Crop:** each artboard takes its window from the shared plate, held as a linked smart object.
7. **Reflow:** foreground layers (product, logo, headline, CTA) are re-placed by anchors and safe zones, never baked into the background.
8. **Check:** render all artboards side by side; verify seams, subject integrity, safe zones, no duplicated objects.

**Worked example: a 1080×1350 (4:5) master**

| Target | Plan | Generation |
| --- | --- | --- |
| 1:1, 1080×1080 | Crop 270 px vertically around the focal point | None |
| 9:16, 1080×1920 | Width fits; height short by 570 px | Vertical band |
| 16:9, 1920×1080 | Crop to 1080 tall if the subject allows | 420 px each side |

The super canvas is the source plus both bands, corners included when the provider needs a rectangle. In Photoshop the result opens as artboards sharing one linked smart object: regenerate the plate once and every size updates.

**Flagship demo for v0.1:** one master image in, a full multi-size campaign PSD out, every layer editable in Photoshop.

## Roadmap and success criteria

Three releases, each gated by its skills' examples passing tests. v0.1 grew to include the broker and segmentation for the adaptation flagship; nothing else moves into it.

&#91;embedded content: roadmap · 3 releases, each with a gate\]

Work flows left to right; a release starts only after the previous gate passes.

**v0.1 success test:** an agent builds a three-artboard campaign (1:1, 4:5, 9:16) from one master image. The PSD opens in Photoshop with every layer editable; a change made there re-imports with nothing lost.

**Testing**

- **Golden images:** render reference documents in Photoshop, store them, and diff our renders against them with a tolerance. This turns PSD fidelity into a measurable number.
- **Round-trip tests:** open, save and re-open real-world PSDs, confirming opaque blocks survive byte for byte.
- **Arabic text:** dedicated golden tests early, since RTL PSD text is the riskiest part of text fidelity.
- **Generative jobs:** test the plumbing (masks, seams, insertion, provenance), not the generated pixels.

**Risks**

| Risk | Mitigation |
| --- | --- |
| Scope creep toward full Photoshop parity | Feature tiers; anything new goes to v0.2 or later |
| Text and adjustments render differently in Photoshop | Write parametric data and our pixels; tolerance-based golden tests |
| PSD format edge cases corrupt files | Opaque passthrough; round-trip suite on real files |
| 8-bit banding in chained adjustments | Planned 16-bit or float path |
| Provider terms restrict commercial use | Review terms before shipping each adapter |
| Retouching quality falls short of luxury standard | Position as a first pass; human finish via the later UI |

**Open questions**

- [ ] Revised v0.1 timeline now that the broker and segmentation are in scope (original estimate: 8 weeks)
- [x] Licence: MIT or Apache-2.0 → **Apache-2.0**
- [x] Project name → **Gesso**
- [ ] First host for the future canvas UI: standalone web app or embedded in an agent host
