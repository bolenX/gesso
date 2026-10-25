# Checks

After grading, measure with `canvas_inspect` before and after (use `revision` for before):

- **Tonal range.** `luminance.range` should run from about 5–15 to 240–250 for a full-range photo, unless you're going for a faded look on purpose. `clipped.highlights` and `clipped.shadows` should stay under about 0.5%, except for speculars and true black.
- **No new colour cast.** `color.cast` on a neutral area (a grey wall, white paper) should read "neutral". Sample neutrals with `samples` and check that R, G and B are within about 4 of each other.
- **Skin stays believable.** Skin samples stay within about 10° of the skin-tone line (`vectorscope.fromSkinLine`).
- **No crushed colour.** `color.chroma.p99` above about 90 means some colours are clipping in saturation. Pull vibrance or saturation back.
- **No banding.** Zoom into smooth gradients (skies, backdrops) at 100–200%. Stacked strong curves can band in 8 bits, so soften the curves or merge the adjustments into one.
