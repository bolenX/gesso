---
name: duotone
description: Duotone and tritone looks (two or three inks mapped to tones with a live gradient map), for posters, covers and brand imagery.
---

# Duotone and tritone

A duotone maps every tone of an image to a blend between two colours: dark ink in the shadows, light ink in the highlights. It unifies mixed photos into one brand look and makes busy images calm enough to put type over.

## Build it

1. Apply `duotone` (or `tritone`) with `skill_apply`, above the image or the group of images to tone. It's a gradient-map adjustment layer, so it stays live: change the inks at any time.
2. Pick the inks:
   - **Dark ink:** deep and close to black, but coloured: navy `#14213D`, aubergine `#2A1033`, forest `#0F2A1D`.
   - **Light ink:** a light colour, near white: pale coral `#FFD2C2`, cream `#F7E9C8`, mint `#C9F5DF`. A mid-tone light ink (a strong coral) halves the contrast.
   - Contrast between the two inks is what makes it read. If they're close in brightness, the image turns to mush.
3. Set contrast first if the photo is flat: a `curves` S-curve below the gradient map.
4. For a print look, add `halftone-pattern` or `color-halftone` on a stamp of the result.

## Variations

- **Tritone:** a mid colour in between, for richer skin and fewer harsh jumps.
- **Partial duotone:** lower the gradient map's opacity (0.6–0.8) to let some original colour through.
- **Duotone with type:** the light ink in large type over the dark half of the image ties text and picture together.
