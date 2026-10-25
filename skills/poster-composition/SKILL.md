---
name: poster-composition
description: Poster and editorial composition: hero image, type over image, scrims for legibility, clipping masks and blend modes, with a clear reading order.
---

# Poster and editorial composition

A poster is read in a second: one image, one message, one action. Build it as a hierarchy.

## Structure

1. **Background:** a colour, or the hero image filling the artboard (`fit: "cover"`, with `focus` on the subject).
2. **Image treatment:** grade it (adjustments skill), or a `duotone` for brand consistency.
3. **Scrim:** a gradient from transparent to dark behind the type, so text reads over any image. Use the `bottom-scrim` or `top-scrim` recipe.
4. **Type:** headline, supporting line and details (typography-hierarchy skill).
5. **Brand:** logo in a corner, kept clear of other elements.
6. **Call to action:** a button or line where the eye ends, usually bottom left or bottom centre.

## Composition rules

- **One focal point.** The largest, highest-contrast element is the first thing seen; everything else is quieter.
- **Margins.** Keep 6–8% of the width as an outer margin, and align everything to it.
- **Type over image.** Put type where the image is calm (sky, wall, out-of-focus areas). Use a scrim where it isn't.
- **Clipping masks:** for type filled with an image (set `clip` on the image above a text layer). **Blend modes:** for shapes that tint the image (`multiply` for dark colours, `screen` for light ones).
- **Contrast.** Text against its background should have a luminance difference of at least 50 levels. Sample with `canvas_inspect`.
