# Checks

Compare the composite with the plate on its own (`compare: { hide: [<placed layers>] }`) and zoom into the edges:

- **Edges.** At 200%, the cut-out's edge has no halo of its old background and no hard stair-steps. Its softness matches the plate's focus.
- **The cut-out, measured.** `canvas_inspect` with `layers: [<cut-out>]`, `matte: true` and `map: "matte"` shows its mask and the cut-out over black, white and red. It reports:
  - **`halo`:** under 10 is clean. Over 20 is a visible fringe: add or raise `decontaminate`, or choke it with `shift` −10 to −20. `haloTone` says which backgrounds it shows on: a lighter fringe on dark ones, a darker fringe on light ones.
  - **`edgeWidth`:** about 1 px for a crisp product edge, a few px for hair. Much wider than the plate's focus looks pasted on, so lower `radius` or add `contrast`.
  - **`specks` and `holes`:** specks are leftover background, or loose strands to keep. Holes are dropouts, like a pale shirt keyed with a white backdrop, or real gaps: look at the map to tell which, and fix dropouts with a vector mask or a lower key `tolerance`.
- **Light.** The placed element is lit from the same side as the plate. Its brightest and darkest tones (`luminance.range` on a region over it) fall within the plate's range.
- **Colour.** The element's average colour (`color.lab`) moves towards the plate's. Sample neutral areas on both: their casts should match.
- **Shadows.** There's a contact shadow where it touches the ground, darker and tighter than the cast shadow, and both point away from the light.
- **Blend If and blend modes.** Check the deepest shadows and brightest highlights of the textured area for hard drop-outs, and widen the split sliders if you see any.
