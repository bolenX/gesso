---
name: product-photo
description: Commercial product and e-commerce workflows in Gesso (clean cut-outs, focus stacking by hand, multi-plate composites, de-speckling, symmetry, label wrapping, contact shadows, glass cut-outs, ghost mannequins, batch catalogue output), as layered recipes.
---

# Commercial product and e-commerce

## 11. Product cut-out

Pick the method by edge type:

- **Hard edges:** a vector mask with an SVG path traced along the product (`{ "kind": "vector", "shape": { "kind": "path", "d": "…" } }`), with a small feather (0.5–1).
- **Soft or complex edges:** `gen_prepare` `remove-background`, then import the cut-out above the original.
- **Fine hair or fur, or glass:** a `channel` mask (see 18).

Check the edges at 200% (`canvas_render` scale 2 with a `region` via a stamp) for halos. Choke them with `minimum` 1 on a copy, or shrink the path.

## 12. Focus stacking (by hand)

There's no automatic align or blend. Import each focus slice as an image layer at the same frame. Mask each slice to where it's sharp, with feathered vector masks, best slice on top. To find sharp areas, `find-edges` on a stamp of each slice shows where detail is.

Shoot on a tripod so the slices align. If they're slightly off, nudge the frames by a pixel or two.

## 13. Multi-exposure composite

Stack the plates (label, glass reflection, liquid fill) as image layers.

- **Label plate:** masked to the label.
- **Reflection plate:** in `screen` with a gradient mask.
- **Liquid plate:** masked to the liquid, with `vibrance` clipped to it.

`blendIf` on the reflection plate (`this: [40, 90, 255, 255]`) keeps only its highlights.

## 14. Surface de-speckling

`dust-and-scratches` (radius 2–3, threshold 10–20) on a stamp, masked to the surfaces only, never to the label text. Add `heal` spots for the bigger specks. To keep the gloss, use `blendIf` `this: [0, 0, 220, 245]` on the cleaned layer, so highlights stay original.

## 15. Symmetry

Duplicate the better half (`duplicate` op), `"flip": "horizontal"`, mask it to that half with a soft-edged vector mask, and align it with `quad` or small `liquify` ops. Then check the label isn't mirrored: mask it out of the flip.

## 16. Label wrap

1. Put the flat label art on its own layer (a smart layer with the label symbol keeps it editable).
2. Bend it with `warp`. A 3-column grid curved around the bottle: move the middle column's points down or out, so the edges recede.
3. Add `displace` with the bottle's own greyscale (a stamp blurred 3) as the map, `scale` [4, 4], so the label follows dents and highlights.
4. Set `"blend": "multiply"` on the label (or `linear-burn` at 0.9) so the bottle's shading shows through.
5. Put a stamp of the bottle highlights above it in `screen` (with `blendIf` `this: [160, 220, 255, 255]`).

## 17. Ground contact shadow

Under the product, build two shadows:

1. **Contact shadow:** a thin black ellipse (5–10% of the product's height), `gaussian-blur` 3–6, `multiply` 0.7.
2. **Soft shadow:** a wider one, `gaussian-blur` 20–40, 0.3.

For a cast shadow, use the product's shape: a `duplicate` with a black `color-overlay`, laid on the ground with `quad`, `field-blur` (sharp near the product, soft far away) and `multiply` 0.4.

## 18. Glass cut-out

Glass is transparent, so a hard mask looks fake. Build it in layers:

1. Shoot it (or keep it) on a plain background. Make two copies: one in `multiply`, with a `channel` mask on the darkest channel (edges and dark refractions), and one in `screen` with a `luminosity` lights mask (highlights).
2. Put these over the new background colour: the background shows through the clear parts.
3. Tint the glass with a `color-overlay` effect at 0.1–0.2 in the background's colour.

## 19. Ghost mannequin

Layers: the exterior shot (masked to remove the mannequin, with feathered vector masks), and the interior (lining) shot below it, scaled and positioned with `quad` so the neck opening lines up.

Darken the interior with `curves` (−20) so it reads as inside. Blend the seam with a soft mask edge and a `heal` spot pass on a stamp.

## 20. E-commerce batch output

1. Build one template document: square artboard (2000×2000), white background, the product image layer (`fit: "contain"`), and the shadow layers.
2. Give the image a frame with the standard margin (8–10%).
3. Run `canvas_batch` with `layer: "product"` and `sources` set to the folder of cut-outs, as `jpeg` or `webp`.
4. For marketplace variants, add artboards (square, 4:5, 16:9) with `artboard_create` from the template first. Each variant is exported per image.
