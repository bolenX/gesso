# Checks

The core techniques are building blocks. After using one, check:

- **Masks.** Render with the masked layer alone (`canvas_inspect` `layers`) to see what the mask lets through. Its edges should be as soft as the subject's.
- **Dodge & burn, vignette and glows change only what they should.** `compare` with the previous revision in `difference` view, and look for changes outside the intended area.
- **Frequency separation is neutral** before you edit it. Compare against the original: the difference should be ΔE under 2 everywhere.
- **Sharpening and high pass.** At 200%, there are no halos along edges.
- **Structure.** Every technique stays live: filters on layers, adjustment layers, masks. Nothing is baked into the original image.
