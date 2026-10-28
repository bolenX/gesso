---
name: compositing
description: Photoshop compositing in Gesso: every blend mode, Blend If, luminosity / colour-range / channel / calculations masks, Select and Mask edge refining, layer styles (bevel, inner shadow and glow, satin, gradient and pattern overlays), boolean shapes, skew, distort, perspective and warp, with recipes for blending objects into scenes.
---

# Compositing

## Blend modes

`"blend"` on any layer (and on adjustment layers and most effects).

| group | modes | typical use |
|---|---|---|
| normal | `normal`, `dissolve` | dissolve: grainy, dithered edges at partial opacity |
| darken | `darken`, `multiply`, `color-burn`, `linear-burn`, `darker-color` | shadows, textures on light ground, removing white backgrounds |
| lighten | `lighten`, `screen`, `color-dodge`, `linear-dodge`, `lighter-color` | light, glows, fire, sparks, removing black backgrounds |
| contrast | `overlay`, `soft-light`, `hard-light`, `vivid-light`, `linear-light`, `pin-light`, `hard-mix` | textures, dodge & burn on 50% grey, high-pass sharpening |
| inversion | `difference`, `exclusion`, `subtract`, `divide` | alignment checks, effects. `divide` by a blurred copy flattens lighting |
| component | `hue`, `saturation`, `color`, `luminosity` | recolouring (`color`), contrast without colour shift (`luminosity`) |

In SVG and PDF exports, Photoshop-only modes are flattened. In a PSD they stay live.

## Blend If (Layer Style › Blending Options)

```json
"blendIf": { "underlying": [0, 0, 120, 200] }
```

- **`this`** hides the layer where its own brightness is outside the range. **`underlying`** does the same by the brightness below.
- **Ranges** are `[black, black split, white split, white]` in levels, 0..255. The layer shows fully between the splits and fades to hidden at the ends.
- **`channel`**: `gray` (default), `red`, `green` or `blue`.

Uses:

- Stamp a texture only into the shadows: `"blendIf": { "underlying": [0, 0, 90, 160] }`.
- Drop a white background from a pasted sketch: `"blendIf": { "this": [0, 0, 200, 245] }`.
- Clouds or smoke only over the sky: `underlying: [100, 180, 255, 255]`.

Blend If stays live in a PSD.

## Computed masks (selections that stay live)

These masks recompute from pixels on every render. `source` is `"below"` (everything under this layer, the default) or a layer id.

| mask | fields | use |
|---|---|---|
| `luminosity` | `range`: lights / darks / midtones or `[low, high]`, `level` 1..5 (higher is narrower), `softness`? | Lights masks for highlight-only grades, Darks for lifting shadows, a band for sky recovery |
| `color-range` | `color`, `fuzziness` 0..200 | recolouring one colour, selecting skies or greenery |
| `channel` | `channel` red / green / blue, `black`?, `white`? (levels to push it to pure black and white) | hair and trees against sky: the blue channel with `black: 60, white: 140`, inverted |
| `calculations` | `a` and `b`: each `{ source?, channel: red / green / blue / gray, invert? }`, `blend` (multiply, screen, overlay, soft-light, hard-light, add, subtract, difference, darken, lighten), `opacity`?, `black`?, `white`? | Image › Calculations: blue × blue in multiply for a deep sky selection, red − blue in subtract to pull skin off a background |

All of them take `feather` and `invert`. In a PSD they're written as pixel masks.

## Selections from a model (Select Subject, Select Sky)

`gen_prepare` with `job: "segment"` and `targets` (subject, sky, skin, eyes, lips, hair, or a short description) prepares a job for the user's segmentation or background-removal tool. Import each result with `asset_import` and `kind: "mask"`: a cut-out's transparency or a black-and-white image's brightness becomes a grey mask. Then use it on any layer:

```json
"mask": { "kind": "raster", "asset": "segment-photo-r4-sky", "of": "photo", "invert": true }
```

`of` names the photo the mask was made from, so the mask follows that photo's frame, crop, focus, rotation, distortion and warp. That way it lines up on an adjustment layer, a group or the photo itself. It takes `invert`, `feather` and `refine` like any mask.

## Refining edges (Select and Mask)

Any raster, vector or computed mask takes `refine`. It treats a band around the mask's edge as uncertain and solves each pixel's opacity there from the layer's own pixels (closed-form matting), so a rough mask snaps to hair, fur and leaves strand by strand. Where the colour clearly disagrees with the rough mask just past the band, as with a strand that runs on beyond it, that's solved too.

| field | range | use |
|---|---|---|
| `radius` | px | how far from the edge to solve: 2–6 for hard edges, 10–30 for hair |
| `smartRadius` | true | keeps the full radius only where the edge has fine detail, and a narrow band along clean edges: one setting for a subject with both, like hair over a jacket |
| `smooth` | 0..100 | evens out a jagged edge |
| `contrast` | 0..100 | hardens the result; keep at 0 for hair |
| `shift` | −100..100 | moves the edge in (negative, chokes halos) or out |
| `decontaminate` | 0..100 | Decontaminate Colors: each edge pixel's colour without the old background mixed in, estimated pixel by pixel, so strands keep their own colour |

```json
"mask": { "kind": "vector", "shape": { "kind": "ellipse" }, "feather": 6, "refine": { "radius": 15, "smartRadius": true, "decontaminate": 70 } }
```

The closer the rough mask, the better the result: a good segmentation (`gen_prepare` `segment`) plus `refine` beats a loose ellipse plus `refine`.

### Studio backdrops and clean plates

Two keys make the rough mask for you, then `refine` takes it to the hair:

- **`backdrop`**: a subject on a plain backdrop (white, grey, green, any colour). The backdrop's colour is read from the image's border, lighting falloff and vignette included, or set with `color`. Pixels within `tolerance` (ΔE, default 10) of it are backdrop. It reads the layer's own pixels, so put it on the photo itself.
- **`difference`**: the same scene shot without the subject, a clean plate. Put that shot on an image layer (hidden), line it up with `canvas_align`, and name it in `plate`. Whatever differs from it by more than `tolerance` (ΔE, default 8) is subject.

```json
"mask": { "kind": "backdrop", "refine": { "radius": 12, "smartRadius": true, "decontaminate": 80 } }
"mask": { "kind": "difference", "plate": "empty-set", "refine": { "radius": 10 } }
```

On their own the keys are hard-edged: always add `refine` for hair. Raise `tolerance` if backdrop shows through in shadows, and lower it if pale parts of the subject drop out. `fillHoles` fills see-through pockets inside the subject, which is how a glass object's key becomes its silhouette.

### Choke and spread

Any mask takes `choke`, applied after everything else:
- **Positive (px):** pulls the edge in, like Photoshop's Minimum on a mask: 1–3 removes a rim of old background.
- **Negative:** pushes it out, like Maximum: it recovers an edge cut too tight, or makes a sticker outline.

`chokeShape` is `round` (the default, for people and organic shapes) or `square` (for straight-edged objects). The cutouts skill covers when to use which method, and the check loop.

### Saturation masks

`{ "kind": "saturation", "black": 10, "white": 50 }` selects by how colourful pixels are. Use it to apply something only to coloured parts (a glass's tint, not the clear glass) or, inverted, only to neutral ones.

A vector mask with `stroke` (a width in px) is the path's outline instead of its area, with round ends: a brush stroke along the path, for dodge & burn lines and painted-in edges. Shape layers' `stroke` also takes `cap` (`butt`, `round`, `square`) and `join` (`miter`, `round`, `bevel`).

```json
{ "id": "warm-lights", "type": "adjustment", "adjustment": { "kind": "photo-filter", "color": "#EC8A00", "density": 30 },
  "mask": { "kind": "luminosity", "range": "lights", "level": 2 }, "frame": { "x": 0, "y": 0, "w": 1080, "h": 1350 } }
```

## Layer styles (`"effects"`)

Effects follow the layer's pixels, and all stay live in a PSD apart from pattern overlay.

| effect | fields (defaults) |
|---|---|
| `drop-shadow` | `color` (#000), `opacity` (0.35), `angle` (120), `distance` (10), `size` (10), `spread` |
| `outer-glow` | `color` (#FFF), `opacity`, `size` (20), `spread` |
| `inner-shadow` | `color` (#000), `opacity` (0.75), `angle` (120), `distance` (5), `size` (5), `choke`, `blend` (multiply) |
| `inner-glow` | `color` (#FFFFBE), `opacity` (0.75), `size` (5), `choke`, `source` edge / center, `blend` (screen) |
| `bevel` | `style` inner-bevel / outer-bevel / emboss / pillow-emboss, `depth` % (100), `direction` up / down, `size` (5), `soften`, `angle` (120), `altitude` (30), `highlight` / `highlightOpacity`, `shadow` / `shadowOpacity` |
| `satin` | `color` (#000), `opacity` (0.5), `angle` (19), `distance` (11), `size` (14), `invert`, `blend` (multiply) |
| `color-overlay` | `color`, `opacity`, `blend` |
| `gradient-overlay` | `stops`, `angle` (90), `style` linear / radial / reflected, `scale` %, `reverse`, `opacity`, `blend` |
| `pattern-overlay` | `asset` (an image that tiles), `scale` %, `opacity`, `blend`. In a PSD it becomes a clipped pixel layer |
| `stroke` | `color`, `width`, `position` outside / inside / center |
| `background-blur` | `radius` (frosted glass) |

Recipes:

- **Embossed logo on a texture**: `bevel` (size 4, depth 120, soften 2), `inner-shadow` (distance 2, size 3, opacity 0.4), with `fillOpacity: 0`. Only the bevel and shadow show, so the texture reads through.
- **Glassy button**: `gradient-overlay` white→transparent-ish in `overlay`, `inner-glow` white size 6, `bevel` size 6 soften 4, `drop-shadow` size 18 opacity 0.25.
- **Gold text**:
  1. `gradient-overlay` stops `#7A5A1E`, `#F5D77A`, `#8C6A25`, `#FFF2B0` at angle 90
  2. `bevel` size 5 depth 200, `highlight` `#FFF6D8`, `shadow` `#4A3510`
  3. `satin` opacity 0.3

## Shapes: booleans

```json
"shape": { "kind": "compound", "parts": [
  { "shape": { "kind": "rect", "radius": 24 } },
  { "shape": { "kind": "ellipse" }, "frame": { "x": 40, "y": 40, "w": 120, "h": 120 }, "op": "subtract" } ] }
```

Ops are `add`, `subtract`, `intersect` and `exclude`, applied in order. Each part has its own `frame` within the layer's box. The result stays a vector in SVG, PDF and PSD.

## Transforms

| field | effect |
|---|---|
| `skew` | [x°, y°]: slants around the centre (stays live in a PSD) |
| `quad` | four corners `[[x, y] ×4]` (TL, TR, BR, BL) in the parent's coordinates: Distort and Perspective. Use it to put art on a sign, screen or box face |
| `warp` | a grid of `[x, y]` fractions of the box (≥ 2×2), bent smoothly. Use it for flags, curved labels and wrapping onto bottles. Start from the even grid and move points |

Distorted and warped layers are pixels in a PSD. For a corner pin that stays editable, put the art in a symbol and place it with a smart layer's `quad`.

## Recipes: blending an object into a scene

1. **Cut-out**: the object on its own layer, with a raster mask, or a `channel` mask for hair or foliage. Add `refine` with `decontaminate` so its edge takes on none of the old background's colour.
2. **Match tone**: a `curves` adjustment clipped to the object (`"clip": true`), with highlights and shadows matched to the scene.
3. **Match colour**:
   - a `match-color` filter on the object, with the plate as `source`; or
   - a `photo-filter` clipped to it, in the light's colour.
4. **Contact shadow**: a black ellipse under the object, `gaussian-blur` 8–20, in `multiply` at 0.6. Add a second, wider and softer one at 0.25.
5. **Light wrap**: a copy of the background, blurred 20–40, clipped to the object in `screen` at 0.3. Mask it to the edges with an inverted, feathered vector mask.
6. **Atmosphere**: a `clouds` filter on a full-frame shape in `screen` at 0.15–0.3, masked to the far distance (a `luminosity` lights mask works well).
7. **Grain**: the same `noise` (monochrome, 0.03–0.06) on the object and the plate, so they read as one photo.
