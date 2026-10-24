---
name: adapt-sizes
description: Adapt one finished design to other sizes (story, square, landscape, banners) so every version looks designed for its size, not squeezed into it.
---

# Adapt a design to more sizes

Use this when someone has one finished artboard and wants it in other formats: "make this a story too", "I need 1:1, 4:5 and 9:16", "give me the banner set".

## Before you start

1. Read the document with `canvas_outline`, and render the source artboard with `canvas_render` so you know what the design looks like.
2. Work out what matters in it: the headline, the product or subject, the logo, the call to action. Everything else (texture, decoration, secondary copy) can move, shrink or go.
3. Pick the targets. Use presets where they exist (`instagram-story`, `instagram-square`, `x-post`, `iab-300x250` and others; `artboard_create` lists them all), or a `size` for anything else.

## Make each size

For each target, call `artboard_create` with `from` set to the source artboard. It re-places every layer:

- layers near an edge stay on that edge; layers in the middle stay centred
- sizes, type, corner radii and strokes scale evenly by the smaller axis ratio, so nothing distorts
- layers spanning the full width or height (backgrounds, colour bands) stretch to the new edges
- image layers with `fit: "cover"` re-crop around their `focus`

Then look at the preview it returns and fix what reflow can't judge, with `canvas_patch`:

- **Tall sizes (9:16):** there is spare height. Move the headline up and enlarge it (`style.size`), give the subject more room, and keep everything inside the safe zone the tool reports: platform buttons and captions cover the top and bottom.
- **Wide sizes (16:9, 1.91:1):** there is spare width. Put the text block on one side and the subject on the other, instead of stacking them.
- **Small banners (300×250, 728×90, 320×50):** much smaller and a different shape. The tool warns when the shape changes a lot. Keep only the headline (shortened if needed), the logo and the call to action, made as large as fits; hide or remove the rest (`"visible": false`). Text under about 12 px is unreadable.
- **Images:** if the subject is cut off, set `focus` on the image layer to its position, as [x, y] fractions of the image (for example `[0.5, 0.3]`).
- **Text that overflows:** the tool lists overflow warnings. Shorten the copy, widen the box, or turn on `"box": { "kind": "area", "shrinkToFit": true }`.

## Check before you finish

Render all the artboards together with `canvas_render` and look at them side by side:

- Is the headline readable at a glance in every size?
- Is the subject whole, and not cropped at an awkward point (heads, product edges)?
- Are text and logos inside the safe zones?
- Does each size look intentional, not just smaller?

Then export with `canvas_export`. A PSD keeps every size as its own artboard in one file.

## When the background is too short or too narrow

If a photo background can't cover a new shape without cropping out the subject, it needs extending (outpainting). Until Gesso's generation hand-off (`gen_prepare`) arrives, tell the user which artboards need more background, and use a colour or gradient that matches the photo's edge as a stand-in.
