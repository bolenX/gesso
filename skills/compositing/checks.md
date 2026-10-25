# Checks

Compare the composite with the plate on its own (`compare: { hide: [<placed layers>] }`) and zoom into the edges:

- **Edges.** At 200%, the cut-out's edge has no halo of its old background and no hard stair-steps. Its softness matches the plate's focus.
- **Light.** The placed element is lit from the same side as the plate. Its brightest and darkest tones (`luminance.range` on a region over it) fall within the plate's range.
- **Colour.** The element's average colour (`color.lab`) moves towards the plate's. Sample neutral areas on both: their casts should match.
- **Shadows.** There's a contact shadow where it touches the ground, darker and tighter than the cast shadow, and both point away from the light.
- **Blend If and blend modes.** Check the deepest shadows and brightest highlights of the textured area for hard drop-outs, and widen the split sliders if you see any.
