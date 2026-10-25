---
name: restoration
description: Photo restoration and archival workflows in Gesso (damage assessment, cracks, missing parts, print patterns and moiré, grain, colourising old photos, faded contrast, stains, glass and emulsion damage, archival TIFF masters), as layered recipes.
---

# Restoration and archival

Keep the scan untouched at the bottom. Restoration happens on stamps and adjustment layers above it, so every step can be revisited.

## 41. Damage assessment

Make a temporary `black-white` adjustment with extreme weights (try `reds: 300` or `blues: -200`) to find the channel where cracks and stains stand out most.

For a crack map, use a `find-edges` stamp, or `curves` with high contrast. Hide or delete these aids once you know where the damage is.

## 42. Cracks and tears

- **Small cracks:** `heal` spots along them (narrow, overlapping ellipses) on a stamp.
- **Larger losses in background areas:** `content-aware-fill`.
- **Over faces and edges:** `clone` from the matching area with a careful `offset`.

Go in passes: rough, then detail. Render at scale 1 to check for repeated patches.

## 43. Missing parts

- **Symmetric features** (an eye, an ear, a sleeve): `duplicate` the good one, `"flip": "horizontal"`, mask it to the missing area with a soft edge, align with `liquify` or `quad`, and match tone with `curves` clipped to it.
- **Texture:** a `noise` layer matched to the scan's grain over the reconstruction.
- **Big losses:** `gen_prepare` `fill` with a prompt describing what was there. Treat this as a reconstruction and note it.

## 44. Print patterns and moiré

There's no FFT filter. Approximate:

1. `median` 2–3 (or `smart-blur` radius 3, threshold 20) on a stamp, in `color` blend, to remove the colour moiré.
2. The same in `luminosity` blend at 0.5 for the dot pattern.
3. Mask it to areas without fine detail.
4. Rebuild the edges with `smart-sharpen` (radius 1) on a stamp above.

## 45. Grain unification

1. Even out existing grain: `reduce-noise` (strength 4–6, preserveDetails 60), or `surface-blur` radius 3, threshold 15.
2. Add one uniform grain: `noise` on a 50% grey layer in `overlay` (monochrome, amount 0.04–0.08, size 1–2, gaussian).

This makes repaired and original areas match.

## 46. Colourising

1. Base: `gradient-map` from dark brown to warm cream in `color` at 0.3, for an overall sepia-neutral base.
2. Areas: shape layers in the researched colours (skin `#C68863`, sky, uniforms) in `color` blend, masked to each area with feathered vector masks (or `color-range` / `luminosity` masks).
3. Use `soft-light` at 0.3–0.5 for subtler tints.
4. Skin needs variation: redder cheeks and lips with small masked layers.

Research period colours (uniforms, cars, fabrics) and note any assumptions.

## 47. Faded contrast

1. `levels` pinning the black and white points: `inputBlack` at the darkest real tone, `inputWhite` at the brightest.
2. `curves` for midtone contrast.
3. Local dodge & burn (curves layers with feathered masks) to restore lost modelling in faces.

## 48. Stains

Select the stain by colour: `color-range` mask on the stain colour (yellow/brown, fuzziness 40–80). Apply `hue-saturation` saturation −100, then `curves` matching its brightness to the surroundings, both with that mask. Clean up the stain edges with `heal`.

## 49. Glass and emulsion damage

- **Reflections and haze on a print scanned through glass:** `camera-raw` `dehaze` 20–40 masked to the hazy areas, plus `heal` for the specular spots.
- **Fused emulsion texture:** frequency separation (see the retouching skill). Clean the high-frequency layer with `heal` and `dust-and-scratches` (radius 1–2), keeping the low frequency. Then micro contrast: `high-pass` 10 in `soft-light` at 0.3.

## 50. Archival master

Export a `tiff` (LZW, lossless) at scale 1. For print, add a CMYK copy (`color: "cmyk"` with the lab's `profile`).

Keep the Gesso document (`.gesso/<id>.json`) and a `psd` export alongside it, so every step stays editable. Record provenance in each layer's `meta.description`: what was reconstructed, and from what.
