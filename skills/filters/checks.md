# Checks

- **Zoom in.** Render the filtered area at 100% with a `region`, and compare with the unfiltered layer (`compare` with `hide`, or the revision before).
- **Blurs** soften what they should. `sharpness` drops in the blurred region and stays in the parts meant to be sharp (tilt-shift band, iris centre, path-blur subject).
- **Sharpening, high pass and Camera Raw clarity** raise `sharpness` without clipping. Check `clipped.highlights` and look for halos at 200%.
- **Noise and grain.** `noise` should match the photo's own grain where filters are mixed with original areas.
- **Distortions** (liquify, warp, glass) keep straight lines that should stay straight, such as the horizon and door frames, unless the effect is meant to bend them.
- **Fade.** Use a filter's `opacity` and `blend` to tone it down, rather than stacking another layer.
