---
name: photo-manipulation
description: Advanced photo manipulation and digital art workflows in Gesso (key visual composites, relighting, edge integration, atmospheric depth, texture mapping, particles and FX, silhouette extraction, palette harmonising, perspective matching, fantasy grading), as layered recipes.
---

# Photo manipulation and digital art

## 31. Key visual composite

1. Background plate (`fit: "cover"`).
2. Extract each subject: `remove-background` jobs, or channel and vector masks.
3. Place the subjects with frames scaled to match the plate's perspective: people's eye level should sit near the horizon line for a camera at eye height.

Group each subject with its own fixes (clipped curves, shadows), so it moves as one.

## 32. Light direction alignment

- **Remove the subject's original light:** `curves` clipped to the subject, lifting the shadows on the wrong side (masked with a feathered shape).
- **Relight:** a darkening `curves` on the side away from the plate's light, and a brightening one towards it. Or use `lighting-effects` with a `spot` from the plate's light direction on a stamp of the subject, at 0.5.
- **Highlights:** white shapes blurred 4–10 in `screen` on the lit edges.

## 33. Edge integration

- **Inner shadow** effect: colour from the plate's shadows, distance 0, size 3–6, opacity 0.3. It darkens the cut-out's edges like real occlusion.
- **Light wrap:** a blurred background copy clipped to the subject, `screen` 0.3, edge-masked.
- **Edge softness:** a `gaussian-blur` 0.5–1 copy of the subject under it, or a tiny feather on its mask, matching the plate's focus.

## 34. Atmospheric depth

- **Haze:** a full-frame shape with `clouds` (scale 300+) in `screen` at 0.1–0.3, masked to the distance, more towards the horizon.
- **Background contrast fade:** `curves` with lifted blacks `[0, 30]`, masked to the far planes.
- **Foreground blur:** `gaussian-blur` or `lens-blur` on near elements. A `lens-blur` with a depth map (from an image tool) gives real depth of field.

## 35. Texture mapping

A texture (cracks, rust, tattoo) on a surface:

1. The texture layer with `displace`, using a stamp of the surface (greyscale, blurred 2–3) as the map.
2. `blend` `multiply` or `overlay`.
3. `blendIf` `underlying` to drop it out of the deepest shadows and brightest highlights.
4. Clip it to the subject.
5. Light it with `curves` masked like the surface's own shading.

## 36. Particles and FX

- **Sparks, embers, dust:** many small white or orange ellipses (or one image of particles) in `screen` or `linear-dodge`, with `motion-blur` along the motion and `outer-glow`.
- **Fire and smoke plates:** image layers in `screen`, which drops the black.
- **Speed:** `path-blur` along the movement.

Vary size and blur for depth: far particles small and sharp, near ones big and blurred.

## 37. Complex silhouettes

Hair or foliage against sky:

1. A `channel` mask on the channel with the most contrast (usually blue), with `black` / `white` pulled in until the background is pure white and the subject pure black. `invert` it.
2. Add a vector mask (on a group around the layer) for solid areas the channel misses. The two masks multiply.
3. Add `refine` to the mask: `{ "radius": 15, "decontaminate": 70 }`. It snaps the edge to the strands and replaces the old sky's colour in them with the subject's own.
4. If a halo remains, choke it with `shift` −10 to −20 in the refine, or a `minimum` 1 copy.

## 38. Palette harmonising

1. `match-color` on each element with the plate as `source` (intensity 60–80, fade 20).
2. A solid colour layer (a full-frame shape in the dominant colour) in `color` or `soft-light` at 0.1–0.2, over everything.
3. One shared grade on top (`curves`, `gradient-map` in `soft-light`), so everything sits in the same light.

## 39. Perspective matching

Find the plate's vanishing lines and put the inserted art on that plane with `quad` (four corners on the plane). For signs, posters and screens, a smart layer with `quad` keeps the art editable. Scale by the plane: items further away get smaller in proportion to the receding edges.

## 40. Fantasy grading

1. `channel-mixer` swaps for alien palettes: `red: [0, 100, 0, 0]`, `green: [100, 0, 0, 0]` for an infrared-style look.
2. `selective-color` exaggeration: `greens` towards cyan, `reds` towards magenta.
3. `color-lookup` with a creative `.cube` LUT (import it with `asset_import`) at 0.6–0.8 opacity.
4. Finish with a `gradient-map` in `soft-light` and `noise` grain.
