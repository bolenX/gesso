---
name: beauty-retouch
description: High-end editorial and beauty retouching workflows in Gesso (skin clean-up, micro smoothing, contour sculpting, eyes, hair, makeup, wardrobe creases, cinematic grading, high-end sharpening, print proofing), as layered, non-destructive recipes.
---

# High-end editorial and beauty

## Layer structure

Build this structure first, then follow the workflows in order. Group ids are suggestions; keep them meaningful. Layers are listed bottom to top.

```
photo                 the original, never edited
group "retouch"       stamps and fixes: heal, frequency separation, liquify
group "shape"         dodge & burn curves, contour
group "colour"        grading adjustments
sharpen               a stamp with high-pass, last
```

**Masks for skin, eyes and lips.** If the user has a face-parsing or segmentation tool connected, start with one `gen_prepare` `segment` job on the photo, with `targets: ["skin", "eyes", "lips", "hair", "teeth"]`. Import each mask with `kind: "mask"`, then use them on the steps below: `{ "kind": "raster", "asset": "<assetId>", "of": "<photo id>" }` on an adjustment or a group keeps it to that part of the face. Without one, use feathered vector ellipses and `color-range` masks.

Use `canvas_stamp` whenever a step needs the pixels so far. Work at full size, and check with `canvas_render` at scale 1 cropped to the face. Use the `region` of a stamp to keep files small.

## 1. Skin clean-up

Add the `heal` filter on a stamp, with one spot per blemish. Spots are about 1–2% of the face width: `{ "at": [x, y], "size": [0.012, 0.012] }`.

Where pores get smeared, use `clone` from a nearby patch of clean skin (an `offset` of 20–60 px). Keep the pores: healing should leave texture, not blur.

## 2. Micro tonal smoothing

Use frequency separation (retouching skill). On the low layer, add `surface-blur` (radius 8–12, threshold 10–20) masked to the cheeks and forehead.

For micro dodge & burn, add two `curves` layers (+/− 10 levels in the midtones) in `luminosity` blend. Mask them with small feathered ellipses over the dark and light blotches. Keep opacity at 0.3–0.6.

## 3. Face contour sculpting

Global dodge & burn: a brightening `curves` masked to the cheekbones, nose bridge, chin and forehead centre, and a darkening `curves` masked under the cheekbones, along the jaw and at the temples. Use feathers of about 8% of the face. Exaggerate the highlights slightly, and deepen the shadows at 0.4–0.6 opacity.

## 4. Eyes and sclera

- **Veins:** `heal` spots on the sclera.
- **Whites:** a `hue-saturation` layer with `ranges: { reds: { saturation: -40, lightness: 8 } }`, masked to the sclera.
- **Catchlights:** a `sharpen` (amount 0.8, radius 0.6) stamp masked to the eyes.
- **Iris colour:** `vibrance` +30, plus `curves` lifting the midtones, masked to the irises.

Keep the whites under pure white: the eyes should look natural.

## 5. Hair

- **Flyaways:** `heal` or `content-aware-fill` spots along the outline, against the background.
- **Gaps:** `clone` from the hair beside them, with an offset along the strand direction.
- **Volume:** `liquify` `bloat` (radius 0.1–0.2, strength 0.2) or `forward-warp` at the crown.

## 6. Makeup

- **Colour pop:** `hue-saturation` `ranges` on the lips or eyeshadow colour (saturation +15–25), masked.
- **Shimmer:** a `noise` layer (0.15, monochrome) in `screen`, masked to the lids, opacity 0.3.
- **Edges:** `sharpen-edges` on a masked stamp.

## 7. Wardrobe creases

Frequency separation on the garment. On the low layer, `heal` along the fold shadows, or `surface-blur` with a high threshold, masked to the creases. Keep the high layer's weave texture. Small `liquify` `forward-warp` ops straighten seams.

## 8. Cinematic colour grading (group "colour")

1. `curves` S-curve in `luminosity`, with matte blacks `[0, 18]`.
2. `color-balance`: shadows `[-15, 0, 20]` (teal), highlights `[15, 0, -15]` (warm).
3. `selective-color`: `reds [-10, 5, 10, 0]` for skin warmth, `blues [15, 0, -10, 0]`.
4. `gradient-map` deep teal → warm cream in `soft-light` at 0.25.
5. Split-tone curves: `curves` with `blue: [[0,20],[255,235]]`.

Check skin stays natural: compare with the photo's skin in the render.

## 9. High-end sharpening

Make the `sharpen` layer a stamp of everything, with a `high-pass` radius of 1–2 in `overlay`. Give it a `luminosity` midtones mask, so highlights and shadows don't crunch. Then mask out skin-smoothing areas with an inverted vector mask if needed.

## 10. Print soft proofing

Render with `proof: "cmyk"`, or with the printer's ICC. If reds or skin go dull or flat, reduce saturation on the out-of-gamut colours (`hue-saturation` ranges), or lift the shadows with `curves` (black-point compensation). Export a `tiff` with `color: "cmyk"` and the printer's `profile` (production skill).
