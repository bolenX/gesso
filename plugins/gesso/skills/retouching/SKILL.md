---
name: retouching
description: "Photo retouching in Gesso: content-aware fill, spot healing, clone stamp, frequency separation, dodge & burn, liquify and skin, all non-destructive, plus Generative Fill jobs for bigger removals."
---

# Retouching

Everything here is non-destructive. Filters sit on a layer (or on a stamped copy of the layers) and stay editable.

## Spots

The retouching filters take `spots`: `{ "at": [x, y], "size": [w, h], "shape"?: "ellipse" | "rect", "feather"? }`.

- `at` and `size` are fractions of the layer's box: `{ "at": [0.42, 0.31], "size": [0.03, 0.03] }` is a small blemish.
- Use one filter with many spots rather than many filters.
- To find coordinates, render with `canvas_render` and estimate. Or look at the image with an image tool first.

| filter | use it for | fields |
|---|---|---|
| `heal` | blemishes, dust, sensor spots, stray hairs, small wires. Matches light and colour to the surroundings | `spots`, `offset`? [x, y] px (Healing Brush source). Without an offset it fills from the surroundings (Spot Healing) |
| `content-aware-fill` | removing objects on textured backgrounds (grass, walls, sky, sand) | `spots` |
| `clone` | exact copies: repeating a pattern, rebuilding an edge | `spots`, `offset` [x, y] px: where to copy from, relative to each spot |

```json
{ "op": "set", "target": "#portrait", "path": "filters", "value": [
  { "kind": "heal", "spots": [{ "at": [0.46, 0.38], "size": [0.02, 0.02] }, { "at": [0.55, 0.41], "size": [0.015, 0.015] }] } ] }
```

Large removals (people, cars, text across a scene) or adding something new need a model. Use `gen_prepare` with `job: "fill"` and `regions`, with a `prompt` to add something or none to remove. Run it with the user's image tool and apply the returned ops. The result lands above the original, masked to the regions.

## Retouching across several layers

First merge them with `canvas_stamp` (Stamp Visible), then retouch the stamp. The originals stay underneath.

## Frequency separation (skin)

1. `canvas_stamp` the photo twice: `low` and `high`.
2. On `low`: `{ "kind": "gaussian-blur", "radius": 6 }`. This holds tone and colour. Use a radius of 4–10 at 1080 px, until pores disappear.
3. On `high`: the same blur, then `high-pass` at the same radius, with `"blend": "linear-light"` on the layer. This holds the texture.
4. Smooth blotches on `low` with `surface-blur` (radius 10, threshold 15), masked to the skin with a soft vector mask. Remove blemishes on `high` with `heal`.

Keep it subtle: render at 100% and check that the pores survive.

## Dodge & burn

Two `curves` adjustment layers:

- **dodge:** `[[0,0],[128,155],[255,255]]`
- **burn:** `[[0,0],[128,100],[255,255]]`

Each gets a mask:

- a vector mask with a big feather for broad shaping (cheekbones, jaw, the subject versus the background); or
- a vector mask with a path and `stroke` (a width in px) for painted strokes along a line: under-eye creases, a jaw line, a highlight down the nose; or
- a `luminosity` mask (`range: "midtones"`) to keep the effect off the highlights and shadows.

Give them `"blend": "luminosity"` so colours don't shift.

## Shape and features

- **`liquify`** with `forward-warp` ops, small radius (0.05–0.1) and strength 0.2–0.4, for subtle reshaping: hair flyaways, clothing folds, a jawline.
- **`puppet-warp`** to move a limb, keeping pins (same from and to) where nothing should move.

Keep reshaping within what's believable. Render and compare against the original.

## Teeth, eyes and skin tone

- **Teeth:** `hue-saturation` with `ranges: { yellows: { saturation: -40, lightness: 10 } }`, masked to the teeth.
- **Eyes:** `curves` lifting the midtones plus `sharpen` 0.5, masked to the irises.
- **Skin tone:** `selective-color` with `reds` / `yellows` shifts. Then `match-color` to a reference image as the source, at intensity 60.

## Checks

Render at scale 1 and look at the retouched areas up close:

- repeated patterns (clone or fill): spread the spots or use `heal`
- smeared texture: use smaller spots
- a halo where light changed: use `heal` instead of `clone`
