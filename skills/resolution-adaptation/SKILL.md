---
name: resolution-adaptation
description: Resolution adaptation: checking each image's effective resolution for its output (screen or print dpi), and upscaling with a generative job where it falls short.
---

# Resolution adaptation

An image looks sharp only if it has enough pixels for the size it's shown at.

## Check

`canvas_inspect` with `preflight: true` warns about every image layer enlarged past 1.25× its own pixels.

For print, work out the effective resolution: the asset's pixel width ÷ the layer frame's width in inches. Aim for:

| Output | Needs |
| --- | --- |
| Screens, social | 1× (2× for retina) |
| Print, close viewing (brochures, cards) | 300 dpi |
| Posters | 150–200 dpi |
| Large format (banners viewed from metres away) | 50–100 dpi |

## Fix

1. **A bigger source** is always best. Ask the user for the original file.
2. **Upscale.** Use `gen_prepare` with `kind: "upscale"` (factor 2 or 4) on the layer. Run the job with the user's upscaler, import the result under the given asset id, and apply the returned ops. The result comes back as a new layer above the original, with provenance.
3. **Make the image smaller** in the layout, if the design allows.
4. **Don't sharpen** to hide softness. It adds halos without adding detail.
