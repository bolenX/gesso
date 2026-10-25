# Checks

- **Each rib shows a shifted slice.** Edges (horizon, outlines) break into steps at the rib boundaries. Render at 100% to see it.
- **Tone is kept.** The overall `luminance.mean` stays within a few levels of the original. Glass shifts pixels; it doesn't darken them.
- **Rib size suits the image.** Ribs much narrower than the subject's features read as noise; ribs wider than the subject hide the effect.
