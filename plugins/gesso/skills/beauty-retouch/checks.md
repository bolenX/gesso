# Checks

Check at 100% on the face, and compare with the first revision:

- **Skin texture stays.** `noise` on a cheek should keep at least about 50% of its original value after smoothing. The smoothing recipe adds back fine grain for this reason.
- **Tone is even, not flat.** `luminance.contrast` on the cheek drops by 10–40%. Contour and cheekbones still read in a small render.
- **Eyes are crisp, not glowing.** Eye `sharpness` rises 5–30%. The whites of the eyes stay off pure white: sample them, and keep them under 245.
- **Colour is believable.** Skin samples sit within about 10° of the skin-tone line. Lips and cheeks keep some red.
- **The grade stays subtle.** Shadows' b* lean cool and highlights' warm, but faces don't turn orange (b* on the forehead under about 35).
- **Sharpening has no halos.** At 200%, edges against the background show no bright or dark outlines.
