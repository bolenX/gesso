---
name: filters
description: Every filter in Photoshop's Filter menu, as Gesso has it (blur, blur gallery, distort, noise, pixelate, render, sharpen, stylize, video, other, the whole Filter Gallery, Camera Raw, Liquify, Puppet Warp, Lens Correction, Adaptive Wide Angle, Vanishing Point), with parameters and when to use each.
---

# Filters

Filters are smart filters: they sit in a layer's `"filters"` list, run in order on the layer's own pixels (before its mask, opacity and blend) and stay editable. Change one with `canvas_patch`, e.g. `{ "op": "set", "target": "#photo", "path": "filters", "value": [...] }`.

- **Positions** (`center`, `at`, `path`, pins) are `[x, y]` fractions of the layer's box: `[0.5, 0.5]` is the middle.
- **Sizes** are pixels unless noted.
- **Fade** (Edit › Fade): every filter also takes `"opacity"` (0..1) and `"blend"` (any blend mode), which mix its result back over the unfiltered pixels. Example: `{ "kind": "high-pass", "radius": 3, "blend": "overlay" }`.
- **Non-destructive habit**: put strong filters on a duplicate layer above the original (same asset and frame) so the original stays untouched, and mask the duplicate to limit where the filter shows.
- Filters that move pixels can pull in transparency at a layer's edges. Make that layer a little larger than the area it fills, or use a full-bleed image.
- In a PSD, 25 common filters stay live smart filters; the rest, the Filter Gallery included, bake into the layer's pixels on their own layer.

## Blur

| kind | parameters | use it for |
|---|---|---|
| `gaussian-blur` | `radius` | general softening, glows, backgrounds |
| `blur`, `blur-more` | — | a touch of softening |
| `average` | — | the layer's average colour (colour sampling, matching) |
| `box-blur` | `radius` | hard-edged, even blur |
| `shape-blur` | `radius` | round, camera-like blur |
| `smart-blur` | `radius`, `threshold` 0..100, `mode`? normal / edge-only / overlay-edge | smoothing that keeps edges, or edge extraction |
| `surface-blur` | `radius`, `threshold` 0..255 | skin and surface smoothing that keeps edges (try radius 6–10, threshold 12–25) |
| `lens-blur` | `radius`, `depth`? (image asset: white near, black far), `focus`? 0..1 (default 1 = nearest) | depth of field from a depth map, bokeh-like |
| `motion-blur` | `angle`, `distance` | straight movement, speed |
| `radial-blur` | `mode` spin / zoom, `amount` (spin: degrees, zoom: 0..1), `center`? | spinning wheels, zoom bursts |

## Blur Gallery

| kind | parameters | use it for |
|---|---|---|
| `field-blur` | `points`: [{ `at`, `radius` }…] (1–16) | blur that varies across the frame: sharp at a 0-radius pin, blurred at others |
| `iris-blur` | `radius`, `center`?, `size`? [w, h] fractions, `feather`? 0..1, `angle`? | subject sharp in an ellipse, blur around it |
| `tilt-shift` | `radius`, `center`?, `angle`?, `band`? (sharp band height, fraction), `transition`? | miniature / tilt-shift look |
| `path-blur` | `path` (2–16 points), `distance` | motion along a curve (see the path-blur skill) |
| `spin-blur` | `angle`, `center`?, `size`? | a spinning object (wheel, fan) in an ellipse |

## Distort

| kind | parameters | use it for |
|---|---|---|
| `displace` | `map` (image asset), `scale` [x, y] px, `fit`? stretch / tile | wrapping a texture or flag over fabric and surfaces. Use the surface's own greyscale, slightly blurred, as the map |
| `pinch` | `amount` −100..100 | squeeze in (+) or bulge out (−) |
| `spherize` | `amount` −100..100, `mode`? normal / horizontal / vertical | bulge like a sphere, fisheye |
| `polar-coordinates` | `mode` rect-to-polar / polar-to-rect | tiny planets, circular patterns |
| `ripple` | `amount` −999..999, `size`? small / medium / large | rippled edges, water |
| `ocean-ripple` | `size` 1..15, `magnitude` 0..20 | underwater, glass-block look |
| `shear` | `offsets` (px across the height) | bending along a curve |
| `twirl` | `angle`, `radius`? (fraction of the shorter side), `center`? | swirls |
| `wave` | `amplitude`, `wavelength`, `angle`? | waves, flags |
| `zigzag` | `amount`, `ridges` 1..20, `style`? around-center / out-from-center / pond-ripples | ripples on water from a centre |
| `glass` | `size`, `amount`, `angle`?, `profile`? ramp / wave | ribbed / fluted glass (see the fractal-glass skill) |
| `diffuse-glow` | `graininess` 0..10, `glow` 0..20, `clear` 0..20 | dreamy bloom on highlights |
| `liquify` | `ops`: [{ `tool`, `at`, `to`?, `radius` (fraction of shorter side), `strength`? 0..1 }…] | reshaping: tools forward-warp (push `at` to `to`), pucker, bloat, twirl-clockwise, twirl-counterclockwise, push-left |
| `puppet-warp` | `pins`: [{ `from`, `to` }…], `rigidity`? 0..1 | bending a limb, tail or object: pin what must stay (same from and to), move the rest |
| `lens-correction` | `distortion`?, `vignette`?, `vignetteMidpoint`?, `redCyan`?, `blueYellow`? (each −100..100) | fixing barrel / pincushion, adding or removing vignette and colour fringing |
| `adaptive-wide-angle` | `correction` fisheye / perspective / full-spherical, `focalLength`? mm (full-frame), `cropFactor`?, `scale`? 50..150 %, `yaw`?, `pitch`? (full-spherical) | fisheye shots made straight; wide shots whose edges look stretched (perspective); a normal view out of a 2:1 360° panorama (full-spherical). Raise `scale` to crop in |
| `vanishing-point` | `plane` (4 corners clockwise from top left), `stamps`?: [{ `from`, `to`, `size`, `heal`? }…], `paste`?: [{ `asset`, `rect`? [u0, v0, u1, v1], `tile`?, `opacity`? }…] | work in perspective on a wall, floor or box side: clone a patch along it (it shrinks with distance), or paste a design or tile a texture onto it. Positions in stamps and rects are fractions of the plane, not the layer |

## Noise

| kind | parameters | use it for |
|---|---|---|
| `noise` | `amount` 0..1, `size`?, `monochrome`?, `distribution`? uniform / gaussian | film grain, matching grain between composited parts (0.03–0.08 monochrome is subtle) |
| `despeckle` | — | light noise clean-up that keeps edges |
| `dust-and-scratches` | `radius` 1..16, `threshold`? 0..255 | removing dust and specks, scan clean-up |
| `median` | `radius` 1..16 | strong smoothing and removing specks |
| `reduce-noise` | `strength` 0..10, `preserveDetails`? 0..100 | denoising photos |

## Pixelate

| kind | parameters | use it for |
|---|---|---|
| `pixelate` | `size` | mosaic, censoring |
| `color-halftone` | `radius` 2..127, `angles`? [c, m, y, k] | pop-art CMYK dots |
| `crystallize` | `size` 3..300 | stained-glass cells |
| `pointillize` | `size` 3..300, `background`? colour | pointillist dots |
| `facet` | — | painterly clumping |
| `fragment` | — | jittery double vision |
| `mezzotint` | `type`? (fine / medium / grainy / coarse dots; short / medium / long lines or strokes) | engraved, gritty texture |

## Render

These replace the layer's colours inside its shape. Put them on a shape layer (a rect over the area) to make a texture, then blend it.

| kind | parameters | use it for |
|---|---|---|
| `clouds` | `colors`? [a, b], `scale`?, `seed`?, `detail`? 1..8 | skies, smoke, haze and texture maps (blend in screen or soft-light) |
| `difference-clouds` | `scale`?, `seed`? | marbled / veined texture mixed with the layer |
| `fibers` | `variance` 1..64, `strength` 1..64, `colors`?, `seed`? | wood grain, hair, fabric fibres |
| `lens-flare` | `at`, `brightness`? 10..300, `lens`? 50-300mm / 35mm / 105mm / movie-prime | sun flare, light hits |
| `lighting-effects` | `lights`: [{ `type` spot / point / infinite, `at`?, `angle`?, `color`?, `intensity`? 0..2, `radius`? }…], `ambient`? 0..1, `height`? 0..100 | relighting, spotlights, relief from the layer's brightness |
| `relight` | `lights`: [{ `at`, `color`?, `intensity`? 0..2, `radius`?, `height`? 0..1 }…], `ambient`? −100..100 (default −30), `depth`? (image asset, white near), `smoothness`? 0..100 | new light on a photo's own shapes: a warm key from one side, a rim from behind. Unlike Lighting Effects it keeps the photo's colour and detail. Pass a depth map for the best shapes |
| `flame` | `path` (points), `type`? one / multiple / candle, `length`?, `width`?, `interval`?, `angle`? (90 up), `turbulence`?, `jag`? 0..100, `color`?, `seed`? | fire along an edge or a path, a candle, burning type. Draws over the layer, so put it on a copy or a shape |
| `picture-frame` | `style`? flat / bevel / double / wood / gold / stripes, `margin`?, `width`?, `color`? | a frame around the layer's edges, with mitred corners and a soft shadow inside |
| `tree` | `type`? oak / maple / pine / willow / birch / bare, `at`? (base, default bottom centre), `height`? (fraction of the box), `leaves`? 0..100, `leafSize`?, `thickness`? %, `leafColor`?, `trunkColor`?, `light`? degrees, `seed`? | trees for scenes and mockups. Draws over the layer; a different `seed` grows a different tree |

## Sharpen

| kind | parameters | use it for |
|---|---|---|
| `sharpen` | `amount` 0..5 (1 = 100%), `radius`?, `threshold`? 0..255 | Unsharp Mask. Final output sharpening: amount 0.6–1.2, radius 0.5–1.5 |
| `sharpen-more`, `sharpen-edges` | — | quick sharpening (edges only skips flat areas) |
| `smart-sharpen` | `amount`, `radius`, `reduceNoise`? 0..100, `remove`? gaussian / lens / motion, `angle`? | recovering soft or motion-blurred detail |
| `high-pass` | `radius`, `scale`? (multiplies the detail; 0.5 for frequency separation) | detail on mid-grey. On a duplicate in `overlay` or `soft-light` it sharpens; radius 1–3 for detail, 8+ for local contrast |

## Stylize

| kind | parameters | use it for |
|---|---|---|
| `diffuse` | `mode`? normal / darken-only / lighten-only / anisotropic | soft, grainy edges |
| `emboss` | `angle`?, `height`? 1..10, `amount`? 1..500 | relief, stamped metal (blend in overlay to keep colour) |
| `extrude` | `size`, `depth` | 3D blocks (approximate) |
| `find-edges` | — | line-art look |
| `glowing-edges` | `width`? 1..14, `brightness`? 0..20 | neon edges on black |
| `oil-paint` | `stylization` 0.1..10, `cleanliness`? 0..10, `shine`? 0..10, `angle`? | painterly look |
| `solarize` | — | photographic solarization |
| `tiles` | `count` (tiles across the shorter side), `offset`? % | broken-tile mosaic |
| `trace-contour` | `level` 0..255, `edge`? upper / lower | contour lines |
| `wind` | `method`? wind / blast / stagger, `direction`? left / right (where streaks go) | wind and speed streaks |
| `cutout` | `levels` 2..8, `simplicity`? 0..10 | flat paper-cutout poster look |
| `poster-edges` | `thickness`?, `intensity`?, `posterization`? 0..6 | inked poster look |
| `halftone-pattern` | `size` 1..12, `contrast`?, `type`? circle / dot / line | greyscale halftone screens |

## Filter Gallery

Photoshop's Filter Gallery, besides Glass, Ocean Ripple, Diffuse Glow, Glowing Edges, Cutout, Poster Edges and Halftone Pattern above. Every field is optional, takes Photoshop's own range, and defaults to Photoshop's default, so `{ "kind": "watercolor" }` alone gives Photoshop's look. Sizes are in pixels and scale when a design is adapted.

- **Sketch filters draw in two inks**, Photoshop's foreground and background colours: `colors` [foreground, background], black and white by default. `{ "kind": "charcoal", "colors": ["#2B1D14", "#F3E9D8"] }` draws in sepia on cream.
- **Textures** (Texturizer, Rough Pastels, Underpainting, Conté Crayon) take `texture` canvas / burlap / brick / sandstone, `scaling` 50..200 %, `relief` 0..50, `light` (top, top-right, … , top-left) and `invert`.
- **Strokes** go one way: `direction` right-diagonal / horizontal / left-diagonal / vertical where Photoshop has it.
- Use `opacity` (Fade) to bring the photo back through a strong effect, and stack two gallery filters as Photoshop's gallery does.

### Artistic

| kind | parameters | use it for |
|---|---|---|
| `colored-pencil` | `width` 1..24, `pressure` 0..15, `paper` 0..50 | crosshatched pencil on grey paper |
| `dry-brush` | `size` 0..10, `detail` 0..10, `roughness` 1..3 (Texture) | dry, flat brushwork with fewer colours |
| `film-grain` | `grain` 0..20, `highlight` 0..20, `intensity` 0..10 | even grain, with a glow in the highlights |
| `fresco` | `size` 0..10, `detail` 0..10, `roughness` 1..3 | coarse, dark, contrasty dabs |
| `neon-glow` | `size` −24..24, `brightness` 0..50, `color`?, `colors`? | a glow in the highlights (or shadows, when size is negative) over the two inks |
| `paint-daubs` | `size` 1..50, `sharpness` 0..40, `brush` simple / light-rough / dark-rough / wide-sharp / wide-blurry / sparkle | painterly daubs |
| `palette-knife` | `size` 1..50, `detail` 1..3, `softness` 0..10 | flat, knife-laid patches |
| `plastic-wrap` | `highlight` 0..20, `detail` 1..15, `smoothness` 1..15 | a shiny film over the forms |
| `rough-pastels` | `length` 0..40, `detail` 1..20, textures | chalky diagonal pastel strokes on a texture |
| `smudge-stick` | `length` 0..10, `highlight` 0..20, `intensity` 0..10 | smeared darks, softened highlights |
| `sponge` | `size` 0..10, `definition` 0..25, `smoothness` 1..15 | sponge-dabbed texture |
| `underpainting` | `size` 0..40, `coverage` 0..40, textures | a soft painting under the image, on canvas |
| `watercolor` | `detail` 1..14, `shadow` 0..10, `roughness` 1..3 | simplified, saturated washes with darker edges |

### Brush Strokes

| kind | parameters | use it for |
|---|---|---|
| `accented-edges` | `width` 1..14, `brightness` 0..50, `smoothness` 1..15 | edges traced in light (brightness above 25) or ink (below) |
| `angled-strokes` | `balance` 0..100, `length` 3..50, `sharpness` 0..10 | diagonal strokes, light areas one way and dark the other |
| `crosshatch` | `length` 3..50, `sharpness` 0..20, `strength` 1..3 | pencil hatching that keeps detail |
| `dark-strokes` | `balance` 0..10, `black` 0..10, `white` 0..10 | short dark strokes in the darks, long white ones in the lights |
| `ink-outlines` | `length` 1..50, `dark` 0..50, `light` 0..50 | pen and ink over the detail |
| `spatter` | `radius` 0..25, `smoothness` 1..15 | airbrush spatter, rough edges |
| `sprayed-strokes` | `length` 0..20, `radius` 0..25, `direction`? | sprayed, angled strokes |
| `sumi-e` | `width` 3..15, `pressure` 0..15, `contrast` 0..40 | Japanese ink on rice paper: rich, soft blacks |

### Sketch

All take `colors` [foreground, background].

| kind | parameters | use it for |
|---|---|---|
| `bas-relief` | `detail` 1..15, `smoothness` 1..15, `light`? | carved low relief |
| `chalk-charcoal` | `charcoal` 0..20, `chalk` 0..20, `pressure` 0..5 | charcoal shadows and chalk highlights on grey |
| `charcoal` | `thickness` 1..7, `detail` 0..5, `balance` 0..100 | smudgy diagonal charcoal |
| `chrome` | `detail` 0..10, `smoothness` 0..10 | liquid, polished chrome (no inks) |
| `conte-crayon` | `foreground` 1..15, `background` 1..15, textures | Conté on textured paper |
| `graphic-pen` | `length` 1..15, `balance` 0..100, `direction`? | fine ink lines |
| `halftone-pattern` | (above) | halftone screens |
| `note-paper` | `balance` 0..50, `graininess` 0..20, `relief` 0..25 | embossed handmade paper |
| `photocopy` | `detail` 1..24, `darkness` 1..50 | a photocopy: edges and darks in toner |
| `plaster` | `balance` 0..50, `smoothness` 1..15, `light`? | moulded plaster, darks raised |
| `reticulation` | `density` 0..50, `foreground` 0..50, `background` 0..50 | clumped film-emulsion grain |
| `stamp` | `balance` 0..50, `smoothness` 1..50 | a rubber stamp: two flat inks |
| `torn-edges` | `balance` 0..50, `smoothness` 1..15, `contrast` 1..25 | ragged torn-paper edges |
| `water-paper` | `length` 3..50, `brightness` 0..100, `contrast` 0..100 | colour blotted into damp, fibrous paper (no inks) |

### Texture

| kind | parameters | use it for |
|---|---|---|
| `craquelure` | `spacing` 2..100, `depth` 0..10, `brightness` 0..10 | cracked varnish or plaster |
| `grain` | `intensity` 0..100, `contrast` 0..100, `type` regular / soft / sprinkles / clumped / contrasty / enlarged / stippled / horizontal / vertical / speckle | grain of many kinds |
| `mosaic-tiles` | `size` 2..100, `grout` 1..15, `lighten` 0..10 | small bevelled tiles that keep the image |
| `patchwork` | `size` 0..10, `relief` 0..25 | squares of one colour at different depths |
| `stained-glass` | `size` 2..50, `border` 1..20, `intensity` 0..10, `color`? (the lead) | leaded glass cells, lit from their centres |
| `texturizer` | textures | the image printed on canvas, burlap, brick or sandstone |

## Video and Other

| kind | parameters | use it for |
|---|---|---|
| `de-interlace` | `eliminate`? odd / even, `create`? duplication / interpolation | video frames |
| `ntsc-colors` | — | broadcast-safe colours |
| `custom` | `kernel` (3×3 or 5×5 numbers), `scale`?, `offset`? | any convolution (custom sharpen, edge or emboss kernels) |
| `hsb-hsl` | `input`, `output` (rgb / hsb / hsl) | channel tricks, e.g. hue into a channel for selections |
| `maximum` / `minimum` | `radius` | grow or shrink light areas (choke or spread mattes, thicken or thin type) |
| `offset` | `x`, `y`, `edges`? wrap / repeat / transparent | seamless-pattern checks (offset by half the size and look for seams) |
| `color-to-alpha` | `color`? (white by default), `transparency`? 0..1, `opacity`? 0..1 | dropping paper out of scanned ink, sketches and logos: the colour goes clear and the rest keeps its own colour, partly see-through where it was faint. Raise `transparency` to clear near-white noise too |

## Retouching

`heal`, `content-aware-fill` and `clone` take `spots` (centre and size as fractions of the box) and remove blemishes and objects. The retouching skill covers them.

## Image › Adjustments as filters

`shadows-highlights`, `desaturate`, `equalize`, `match-color` and `replace-color` are also filters. The adjustments skill covers them, along with the live adjustment layers (curves, levels, colour balance and the rest).

## Camera Raw Filter

`{ "kind": "camera-raw", "exposure"?, "contrast"?, "highlights"?, "shadows"?, "whites"?, "blacks"?, "temperature"?, "tint"?, "vibrance"?, "saturation"?, "clarity"?, "texture"?, "dehaze"?, "vignette"?, "grain"? }`

Exposure is in stops (−5..5); grain is 0..100; the rest are −100..100. Use it for a quick photo grade: for example highlights −40, shadows +35, clarity +20, vibrance +25. Put it on the photo layer, or on a duplicate with an `opacity` to dial it back.

## Check your work

Render with `canvas_render` after adding a filter. Look for:

- transparent or smeared edges: make the layer larger, or the filter weaker
- a filter that overpowers the subject: lower `opacity`, or mask the filtered duplicate
- grain or sharpening that should match across composited parts: use the same settings on each
