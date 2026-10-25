---
name: core-techniques
description: How Photoshop's 50 core professional techniques (selections and masking, dodge & burn, curves, Blend If, colour matching, liquify, displacement, frequency separation, high-pass, grain, ambient occlusion, light wrap, shadows, haze, smart objects, batch, soft proofing, slices, booleans, type on a path, AI fill) map onto Gesso, with the fields to use.
---

# Core techniques, the Gesso way

Gesso is non-destructive by construction: filters, masks and adjustments are data you can change later. Build every technique as layers, plus filters and masks on them. Never bake.

## Selection and masking

| technique | in Gesso |
|---|---|
| Pen paths | `{ "kind": "vector", "shape": { "kind": "path", "d": "M…" } }` masks, or shape layers with SVG paths. Combine shapes with `compound` |
| Channel masks (smoke, glass, hair) | `{ "kind": "channel", "channel": "blue", "black": 70, "white": 150, "invert": true, "source": "<photo id>" }`. Pick the channel with the most contrast between subject and background, then tighten `black`/`white` |
| Calculations | a `calculations` mask: `{ "kind": "calculations", "a": { "channel": "blue" }, "b": { "channel": "blue" }, "blend": "multiply", "black": 40, "white": 160 }`. Each of `a` and `b` takes a `source` (a layer id, or below), a `channel` (red, green, blue or gray) and `invert`. Red against blue in `subtract` separates skin from a background |
| Select and Mask (hair edges) | add `refine` to any mask: `{ "radius": 15, "decontaminate": 70 }` for hair, `radius` 2–6 for hard edges, with `smooth`, `contrast` and `shift` like Photoshop's Global Refinements. Start from a rough mask (a vector mask, a channel mask, or a `remove-background` cut-out) |
| Luminosity masks | `{ "kind": "luminosity", "range": "lights", "level": 2 }` (also darks or midtones, levels 1–5, or a `[low, high]` band) |
| Colour range | `{ "kind": "color-range", "color": "#3A7BD5", "fuzziness": 60 }` |
| Alpha channels | save a selection as a mask asset: `canvas_stamp` a white shape layer on black, then use it as `{ "kind": "raster", "asset": … }` anywhere |

## Tone

| technique | in Gesso |
|---|---|
| Micro dodge & burn | a `curves` brighten layer and a darken layer in `luminosity` blend, each masked with small feathered vector shapes, stroked paths (a vector mask with `stroke`: a brush stroke along the path) or `luminosity` band masks. Keep opacities at 0.2–0.5 |
| Global dodge & burn | the same with big feathered masks (`feather` 10–20% of the face or object) |
| Targeted curves | `curves` with points in one zone only, e.g. `[[0,0],[60,52],[128,128],[255,255]]` deepens shadows only. Add `red` / `green` / `blue` for colour per zone |
| Blend If | `"blendIf": { "underlying": [0, 0, 100, 160] }` and similar (see the compositing skill) |
| Black & white mapping | `black-white` with per-colour weights, then grade above it |
| Gradient map sculpting | `gradient-map` with stops at exact positions; use `soft-light` / `color` blends to grade |

## Colour

| technique | in Gesso |
|---|---|
| LAB manipulation | no LAB mode. For vibrancy use `vibrance` plus `hue-saturation` ranges. For luminance-only changes use `"blend": "luminosity"`; for colour-only, `"blend": "color"` |
| Matching a target colour | `match-color` filter with `source`. Or measure: `average` filter on a stamp of the reference, then `color-balance` / `curves` until it matches |
| Colour casts | `color-balance` per tonal range, or `selective-color` `neutrals` / `whites`, or `match-color` with `neutralize: true` |
| Saturation vs vibrance | `vibrance` lifts muted colours and spares skin; `saturation` is even |
| Chroma fixing (colour bleed) | `hue-saturation` with `ranges` on the bleeding colour, masked to the area. Or a `color`-blend layer painted with the right tone |

## Structure

| technique | in Gesso |
|---|---|
| Liquify | `liquify` filter ops (forward-warp, pucker, bloat, twirl, push-left) |
| Displacement | `displace` with `map` = a greyscale, slightly blurred copy of the surface (stamp, then `gaussian-blur` 2–4, saved as an asset) |
| Vanishing point / perspective | `quad` on the layer (corner pin). For editable art, a smart layer with `quad` |
| Puppet warp | `puppet-warp` pins |
| Perspective correction (keystoning) | `lens-correction` for lens distortion, then `quad` with the top corners pulled out until verticals are straight |
| Content-aware scale | image `"fit": "content-aware"` |

## Texture and detail

| technique | in Gesso |
|---|---|
| Frequency separation | see the retouching skill: stamp twice, then gaussian-blur on low, and high-pass in linear-light on high |
| High-pass sharpening | a stamp with `high-pass` radius 1–3 in `overlay` / `soft-light`, masked by `luminosity` midtones so flat areas stay clean |
| Smart sharpen (deconvolution) | `smart-sharpen` with `remove`: gaussian, lens or motion (with `angle`) |
| Film grain | `noise` (monochrome 0.03–0.08, `size` 1–2, `distribution` gaussian), on a 50% grey layer in `overlay` so it's adjustable |
| Moiré | approximate only: `median` 2 or `smart-blur` on a copy, `"blend": "color"`, masked to the pattern area (removes the colour fringes) |
| Texture synthesis | `content-aware-fill` / `clone` spots, or a `pattern-overlay` effect with a tileable asset |

## Compositing and light

| technique | in Gesso |
|---|---|
| Ambient occlusion | a dark ellipse or path under the contact point, `gaussian-blur` 2–6, `multiply` at 0.5–0.8; a wider, softer one at 0.3 |
| Light wrap | a blurred background copy clipped to the subject, `screen` 0.3, masked to the edges |
| Specular highlights | small white shapes with `gaussian-blur` 1–3 in `screen`, or `lens-flare` at low brightness |
| Cast shadows | duplicate the subject, black `color-overlay`, then `quad` it onto the ground away from the light. Add `gaussian-blur` that grows away from the contact (`field-blur` points) and `multiply` 0.5 |
| Haze and light rays | `clouds` on a full-frame shape in `screen` 0.15; rays are white strips with `motion-blur` in `screen` |
| Texture blending | texture image layers in `overlay` / `soft-light` / `multiply`, with `blendIf` to keep them out of highlights |

## System

| technique | in Gesso |
|---|---|
| Smart object nesting | `symbols` plus `smart` layers. They export as embedded, editable PSD smart objects |
| Actions and batch | `canvas_batch` (template × images or data rows); patch op lists can be re-applied to other documents |
| CMYK soft proofing | `canvas_render` `proof: "cmyk"`, then export `color: "cmyk"` (production skill) |
| Asset generator naming | layer names like `200% hero.png`, then `canvas_export` with `slices: true` |
| Non-destructive structure | groups per area (`retouch`, `grade`, `type`), meaningful ids, `meta.role` and `meta.description` on key layers, adjustments clipped or masked, filters instead of baked pixels |

## Vector and type

| technique | in Gesso |
|---|---|
| Smart filters | all filters are smart (live, ordered, with Fade `opacity` / `blend`), and masks apply after them |
| Boolean shapes | `{ "kind": "compound", "parts": [...] }` with add / subtract / intersect / exclude |
| Type on a path | text `"path": { "d": "…" }` |
| Advanced layer styles | inner shadow and glow, bevel, satin, gradient and pattern overlays, `fillOpacity`, Blend If (compositing skill). There are no knockouts; use masks instead |

## AI

| technique | in Gesso |
|---|---|
| Generative fill and seeds | `gen_prepare` `fill` (regions plus prompt) or `generate`. Run it with the user's image tool; results land as new layers with provenance in `meta` |
| Generative expand | `gen_prepare` `expand` |
| AI blending | generated layers get feathered vector masks, plus `match-color` to the plate and grain matching |
| Neural filters, depth | depth maps from an image tool become `lens-blur` `depth` assets. Skin smoothing is `surface-blur` masked to the skin |
