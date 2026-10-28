# Checks

Every cut-out:
- **Measure the edge.** Run `canvas_inspect` with `layers: [<cut-out>]`, `matte: true` and `map: "matte"`:
  - `halo` is under 10; above 20 it shows as a fringe.
  - `edgeWidth` suits the subject: about 1 px for products, a few px for hair.
  - `specks` and `holes` are explained: any left are stray strands or real gaps, not leftover background or dropouts.
- **On a contrasting colour.** In the map, the cut-out over black, white and red shows no rim on any of them. A halo is only visible against a colour unlike the old background: mid-grey for a white backdrop, dark grey for white fur.
- **At the hardest edges.** `canvas_render` with a `region` at scale 2–3 on the hair, fur, glass rims and fine branches: strands keep their wisps, and hard edges have no stair-steps.
- **Before and after.** Render with `compare` against the revision before the mask, so you see what it removed and kept.

Glass:
- **No backdrop inside.** Sample the clear glass: its colour follows the new background (warm on wood, for example), not the grey it was shot on. `color.lab` in a region of clear glass moves towards the background's.
- **The tint stays.** The liquid's `color.lab` b* (or its hue) stays near the original's. The opaque parts (cap, label) match the photo within ΔE 15.
- **Speculars survive.** The brightest stripe on the glass stays near white: `luminance.mean` over 180 in its region.
- **Refraction and contact.** Lines seen through the glass are offset from the ones beside it. The shadow falls away from the light, and nothing paints over the glass itself.

Light on dark:
- **No box.** The black around the element is clear: the background shows through at the corners of the layer.
- **The dense parts stay bright.** On light backgrounds, the thin parts don't turn grey; if they do, keep `normal` and raise `level`.
