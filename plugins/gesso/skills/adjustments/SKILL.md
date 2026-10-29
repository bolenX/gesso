---
name: adjustments
description: Photoshop's Image › Adjustments as live adjustment layers and filters (curves, levels, exposure, vibrance, colour balance, black & white, photo filter, channel mixer, LUTs, selective colour, shadows/highlights, match and replace colour…), with fields and grading recipes.
---

# Adjustments

There are two ways to adjust colour and tone.

## Adjustment layers (live in the PSD)

An adjustment layer recolours **everything below it** in its group. These all stay live adjustment layers in a PSD.

```json
{ "id": "grade", "type": "adjustment", "adjustment": { "kind": "curves", "points": [[0, 20], [128, 140], [255, 240]] }, "frame": { "x": 0, "y": 0, "w": 1080, "h": 1350 } }
```

- **Limit it**: to part of the image, give it a `mask` (vector shape, or a raster mask asset). To one layer, put it right above that layer with `"clip": true`. To a group, put it inside the group and set the group's `"isolation": "isolate"`.
- **Dial it back** with `opacity`. Use `blend` for classic tricks: `luminosity` changes tone without shifting colour; `color` changes colour only; `soft-light` gives a gentle grade.

| kind | fields | notes |
|---|---|---|
| `curves` | `points` [[in, out], …] (0..255), `channel`? rgb / red / green / blue, `red`? `green`? `blue`? (extra per-channel curves) | S-curve for contrast: `[[0,0],[64,52],[192,206],[255,255]]`. Matte blacks: lift the first point, e.g. `[0, 24]` |
| `levels` | `inputBlack`, `inputWhite`, `gamma`, `outputBlack`?, `outputWhite`?, `channel`? | gamma > 1 brightens midtones |
| `brightness-contrast` | `brightness` −150..150, `contrast` −50..100 | |
| `exposure` | `exposure` (stops), `offset`? −0.5..0.5, `gamma`? | works in linear light; +1 stop doubles the light |
| `hue-saturation` | `hue` −180..180, `saturation` −100..100, `lightness` −100..100, `ranges`? { reds / yellows / greens / cyans / blues / magentas: { hue?, saturation?, lightness? } } | `ranges` edits one colour family, e.g. `{ "blues": { "hue": -10, "saturation": 25 } }` for richer skies |
| `vibrance` | `vibrance` −100..100, `saturation`? | boosts muted colours and spares skin. Prefer it over saturation for people |
| `color-balance` | `shadows`? `midtones`? `highlights`? each [cyan−red, magenta−green, yellow−blue] −100..100, `preserveLuminosity`? (default true) | teal-and-orange: shadows `[-20, 0, 25]`, highlights `[20, 0, -20]` |
| `black-white` | `reds` `yellows` `greens` `cyans` `blues` `magentas` (−200..300 %, Photoshop defaults 40/60/40/60/20/80), `tint`? colour | for mono conversions with control. Darken skies with `blues: -20`; a tint like `#C8A070` gives sepia |
| `photo-filter` | `color`, `density` 0..100, `preserveLuminosity`? (default true) | warming `#EC8A00`, cooling `#006DFF`, 20–35 % |
| `channel-mixer` | `red`? `green`? `blue`? each [from red %, from green %, from blue %, constant %], or `monochrome` [r, g, b, constant] | infrared and channel swaps; monochrome mixes (keep the sum near 100 %) |
| `color-lookup` | `lut` (asset id of a `.cube` file) | import the LUT first: `asset_import` with the .cube file (kind `lut` is detected) |
| `invert` | — | |
| `posterize` | `levels` 2..255 | |
| `threshold` | `level` 1..255 | pure black and white |
| `selective-color` | `reds` `yellows` `greens` `cyans` `blues` `magentas` `whites` `neutrals` `blacks`: each [cyan, magenta, yellow, black] −100..100, `mode`? relative / absolute | skin: `yellows: [0, 0, -10, 0]`, `reds: [-10, 5, 10, 0]`. Deeper blacks: `blacks: [0, 0, 0, 15]` |
| `gradient-map` | `stops` [{ offset, color }], `reverse`? | colour grading by brightness. Put it in `soft-light` or `color` at 20–50 % to tone |

## Adjustment filters (on one layer)

These are Photoshop commands that change a layer's own pixels. In Gesso they are smart filters: they go in the layer's `"filters"`, stay editable, and bake into pixels in a PSD.

| kind | fields | use it for |
|---|---|---|
| `shadows-highlights` | `shadows` 0..100, `highlights`? 0..100, `radius`? (px, default 30), `color`? −100..100 | opening shadows and recovering skies in photos (shadows 25–50) |
| `desaturate` | — | quick greyscale of one layer |
| `equalize` | — | spreading tones across the full range (flat scans) |
| `match-color` | `source`? (image asset), `luminance`? 1..200, `intensity`? 1..200, `fade`? 0..100, `neutralize`? | matching a composited element to its background plate: use the background photo as `source`, intensity 60–100, fade 20–50. `neutralize` alone removes a colour cast |
| `replace-color` | `color`, `fuzziness` 0..200, `hue`?, `saturation`?, `lightness`? | recolouring one colour: a product variant, a shirt, a sign |

The `camera-raw` filter (see the filters skill) does exposure, contrast, highlights, shadows, whites, blacks, white balance, clarity, texture, dehaze, vibrance, vignette and grain in one go.

## Recipes

- **Contrast without colour shift**: `curves` S-curve with `"blend": "luminosity"`.
- **Cinematic grade**:
  1. `curves` with matte blacks
  2. `color-balance` teal shadows, warm highlights
  3. `vibrance` +15
  4. optionally a `gradient-map` dark-teal → cream in `soft-light` at 0.3
- **Dodge & burn, non-destructively**: two `curves` layers, one brightening (`[[0,0],[128,160],[255,255]]`) and one darkening (`[[0,0],[128,96],[255,255]]`). Each is masked to where light should fall or deepen, with a large `feather`.
- **Match a pasted object to the scene**:
  1. a `match-color` filter on the object, with the background as `source`
  2. a `curves` layer clipped to the object (`"clip": true`) to match its contrast
  3. a `photo-filter` clipped to it, in the scene's light colour
- **Black & white with punch**: `black-white` (red 50, yellow 70, blue 10), then a `curves` S-curve above it.

## Check your work

Render with `canvas_render` and compare skin tones, whites and blacks before and after:

- clipped highlights or crushed shadows: soften the curve ends
- colour casts in neutrals: check greys stay grey, or fix with `selective-color` neutrals
- an over-strong grade: lower `opacity`
