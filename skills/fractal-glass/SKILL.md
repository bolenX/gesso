---
name: fractal-glass
description: Put a fluted / fractal / reeded glass effect over any design or background, built from live glass strips so the art underneath stays editable.
---

# Fractal glass

Use this when someone asks for fractal glass, fluted glass, reeded glass, ribbed glass, or "the glass stripes effect" over an image, gradient or layout.

The effect is a row of identical vertical strips laid over the art. Each strip blurs only what's beneath it (a background blur), so every column becomes a soft smear of the colours under it with a crisp seam at its edges, and a thin gradient on each strip adds the ridge highlight and shadow. Nothing is baked: change the art below, move it, or swap the image, and the glass follows.

## Build it

1. Read the document with `canvas_outline` and render it so you know where the art is.
2. Decide the glass area: usually the whole artboard, or the part the user named. Note its x, y, width and height.
3. Choose the strip width. 80 to 120 px on a 1080 px wide design is the classic look; narrower (30 to 60 px) reads as reeded glass, wider (150 px or more) as big flutes. Strips should overlap slightly: step = width × 0.85.
4. Insert one group at the top of the artboard (or just above the layers the glass should cover), named "Fractal glass". It must be pass-through (leave out `isolation`) and have no opacity, blend or effects of its own; otherwise the strips can't see the art beneath it.
5. Inside it, add one strip per step across the area, ids `glass-1`, `glass-2`, …, each exactly like this, changing only `frame.x`:

```json
{
  "id": "glass-1", "name": "Glass 1", "type": "shape", "shape": { "kind": "rect" },
  "frame": { "x": 0, "y": 0, "w": 109, "h": 1350 },
  "fill": { "kind": "linear-gradient", "angle": 0, "stops": [
    { "offset": 0, "color": "#FFFFFF0D" },
    { "offset": 0.76, "color": "#040404" },
    { "offset": 1, "color": "#FFFFFF0D" }
  ] },
  "blend": "overlay",
  "fillOpacity": 0.2,
  "effects": [{ "kind": "background-blur", "radius": 90 }]
}
```

Send everything in one `canvas_patch`: first `{ "op": "insert", "into": "#<artboard-id>", "layer": { "id": "fractal-glass", "type": "group", "frame": <the glass area>, "children": [] } }` (or `after` a layer to place it lower), then one `insert` per strip with `"into": "#fractal-glass"`. Strip frames are relative to the group. When several artboards have glass, scope the target: `"into": "story #fractal-glass"`. Then render.

What each setting does:

- **Gradient** (white 5% → near-black at 76% → white 5%, left to right): the ridge. The dark band sits toward the right edge of each strip, which gives the fluted shading. Move the middle stop (0.6 to 0.85) to shift it; flip the angle to 180 for the opposite lighting.
- **`blend: "overlay"`**: the ridge darkens and brightens the colours beneath instead of painting grey over them.
- **`fillOpacity: 0.2`**: how strong the ridge is (0.1 subtle, 0.35 bold). It fades only the gradient, never the blur.
- **`background-blur` radius**: how frosted each column is. 60 to 120 for the classic smeared columns, 20 to 40 to keep shapes recognisable. (Figma's "background blur 180" is about radius 90.)

## Variations

- **Horizontal glass**: swap the strip's w and h, step along y, and set the gradient angle to 90.
- **Angled glass**: give every strip the same `rotation` (for example 20), make them about 1.5× longer than the area so the corners stay covered, and step them by width × 0.85 ÷ cos(angle) along x. Don't rotate the group: a rotated group renders on its own and its strips can't see the art beneath.
- **Glass on part of the design**: limit the strips to that area; the rest stays sharp. A strip that only partly covers the art smears just what it covers.
- **Text through glass**: keep headlines above the glass group so they stay readable, or below it when the user wants the type itself distorted.

## Check

Render and look at it before finishing:

- Each column should show the colour beneath it, smeared vertically, with clear seams between strips. If the columns look like flat grey bars, the group isn't pass-through or the strips are below the art.
- The ridge should be visible but not muddy; lower `fillOpacity` if the image looks dirty.
- With a photo, check faces and products: a strong blur over them can look like a mistake. Ask, or keep them out of the glass area.

## In Photoshop

Photoshop has no live background blur, so the PSD keeps each strip as a live shape (gradient, Overlay, Fill 20%) and puts its frosted backdrop just beneath it as a pixel layer named "Glass N · background blur". Tell the user that changing the art in Photoshop means re-exporting from Gesso to refresh the frosting, or blurring those layers again by hand.
