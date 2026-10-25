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

If a photo background can't cover the new shape without cropping out the subject, extend it instead (outpainting):

1. Call `gen_prepare` with `job: "expand"`, the artboard and the background image layer. It writes the source, a padded canvas and a mask to the Gesso folder, and returns the target size, aspect ratio, how far to extend each side, and a prompt.
2. Run it with an outpainting or expand tool the user has connected (for example Magnific or Higgsfield). Gesso never pays for or calls a model itself.
3. Import the result with `asset_import` under the `assetId` from the job, then apply the job's `ops` with `canvas_patch`. They put the result in as a separate background layer with provenance, and keep the original photo on top with a soft edge, so its pixels are untouched.
4. Render and check the seams, and that the subject wasn't repeated at the edges.

When several sizes need more background, prepare one job for all of them: add `artboards` with the other sizes (the background layer has the same id in each, as adapted artboards do). The job sizes one plate big enough for every frame, and its ops place that plate in each artboard, lined up with the photo. That means one generation, and the same background in every size. Where a frame doesn't fill its artboard, the plate gets a rectangle mask so it stays inside the frame. If the user has no image tool connected, tell them which artboards need more background and use a colour or gradient matching the photo's edge as a stand-in.
