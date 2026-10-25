---
name: double-exposure
description: Double exposure: a second image (landscape, city, texture) blended inside a portrait's silhouette, with a shared tone so they read as one picture.
---

# Double exposure

Two photos in one frame: usually a portrait, with a landscape or city showing through the person.

## Build it

1. **The portrait.** Put the portrait at the bottom. The cleanest results come from a portrait with a plain, contrasting background: a light face on dark, or a dark silhouette on white.
2. **The texture.** Import the second image (`asset_import`) as an image layer above the portrait.
3. **Blend.** Apply `double-exposure`. It moves the texture above the portrait, sets its blend mode, and masks it to the portrait's light areas, so the texture lives inside the person and the background stays clean.
   - **Light subject on a dark background:** `multiply` (the default) with `range` `lights`.
   - **Dark silhouette on a light background:** `screen` with `range` `darks`.
4. **Placement.** Move or scale the texture so its most interesting part (a skyline, a tree line) runs across the face or shoulders. Keep the eyes clear, or let a horizon cross just below them.
5. **Tone.** Unify the two with a `duotone` or `tritone` above both, or a `gradient-map` in `soft-light` at 0.5.

## Tips

- **Soften the transition** by raising the mask's `softness`, or lower the texture's opacity to 0.8–0.9.
- **Bring back a feature** (an eye, the lips) through the texture by duplicating the portrait above it, with a small feathered vector mask.
