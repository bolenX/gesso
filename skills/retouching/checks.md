# Checks

Before finishing a retouch, check each of these at 100%. Use `canvas_render` with a `region` and `scale` 1–2, or `compare` with the first revision.

- **Nothing moved that shouldn't have.** Compare with the original (`compare: { revision: 0 }`, view `difference`). Changes should sit only where you retouched: skin, spots, the areas you dodged or burned. Eyes, lips, hair edges and clothing should stay dark in the difference image.
- **Texture survives.** In `canvas_inspect`, compare `noise` on a cheek region before and after. It should stay within about 30% of the original. Below that, skin turns plastic: lower the smoothing amount, or smooth only the low-frequency layer.
- **Tone is even, not flat.** Luminance `contrast` on the cheek should drop, typically by 10–40%. If it falls further, the face loses its shape. Dodge & burn should restore the modelling.
- **Blemishes are gone and the heals don't show.** Zoom to 200% on each spot. A healed spot matches its surroundings within about ΔE 3. Sample with `samples` and a `sampleSize` of 5. Watch for repeated patches, smears and soft halos.
- **Eyes and lips stay sharp.** `sharpness` in an eye region shouldn't drop by more than about 5%.
- **Skin colour stays believable.** Skin samples should sit within about 10° of the skin-tone line (`vectorscope.fromSkinLine`). Larger shifts look ill (towards green or yellow) or sunburnt (towards red).
- **The structure is clean.** The original stays at the bottom, untouched. Each step is its own named layer, so it can be turned off or changed.
