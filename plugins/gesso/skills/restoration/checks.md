# Checks

- **Damage is gone.** Zoom to 100–200% along each former scratch and tear. No lines or smudges should remain, and no repeated patches.
- **Grain is even.** `noise` in repaired areas is within about 20% of untouched ones. Add a grain layer (grain-unify) if it isn't.
- **Tonal range is restored.** `luminance.range` spans about 10–245 after levels, with highlights not blown (`clipped.highlights` under 0.5%).
- **Stains are gone.** A stained area's chroma (`color.chroma.mean`) is close to its surroundings', and its brightness matches.
- **Reconstructions are honest.** Every reconstructed or generated area is recorded in its layer's `meta.description`.
