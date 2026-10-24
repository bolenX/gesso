---
name: glass-refraction
description: Make a photo or design look like it's seen through ribbed / reeded glass, with each rib showing a shifted slice of the image.
---

# Glass refraction

Use this for "glass refraction", "ribbed glass", "reeded glass" or "shower glass" looks over a photo, portrait or poster. It's Photoshop's Glass filter with a striped ramp texture, built in as the `glass` filter, so it stays live: change the photo or the settings at any time.

It differs from fractal glass (the `fractal-glass` skill). Refraction *moves* the image inside each rib, so edges and features repeat and step. Fractal glass *frosts* the image under each strip.

## Build it

1. Find the layer to refract, usually the photo or the full design. To refract several layers together, put them in a group with `"isolation": "isolate"` and filter the group.
2. Add the filter with `canvas_patch`:

```json
{ "op": "set", "target": "#photo", "path": "filters", "value": [{ "kind": "glass", "size": 60, "amount": 40 }] }
```

- **`size`**: rib width in pixels. 2–4% of the image width is the classic look (40–90 px on a 2000 px photo). Thinner ribs read as fine reeded glass.
- **`amount`**: how far each rib shifts the image. Around 0.5–0.8 × `size` gives clear stepping; above 1.5 × `size` the image breaks into repeated slivers.
- **`angle`**: 0 for vertical ribs (default), 90 for horizontal, anything between for diagonal glass.
- **`profile`**: `"ramp"` (default) for hard-edged ribs like the Photoshop texture method; `"wave"` for smooth, rounded flutes.

3. Render and look. Keep faces readable: if eyes or mouths are sliced badly, lower `amount` or shift the photo slightly so a rib edge doesn't run through the middle of the face.

## Variations

- **Only part of the image behind glass**: put a refracted copy above the original and mask it, for example `{ "kind": "vector", "shape": { "kind": "rect" }, "frame": { "x": 0, "y": 0, "w": "50%", "h": "100%" } }` for the left half.
- **Glass plus colour**: add a `gradient-map` adjustment or a colour-overlay layer above for the neon look, or a subtle white gradient in `overlay` above the ribs for highlights.

## In Photoshop

The PSD keeps the layer with the refraction applied to its pixels (Photoshop has no equivalent live filter it can read). Keep the Gesso document for changes.
