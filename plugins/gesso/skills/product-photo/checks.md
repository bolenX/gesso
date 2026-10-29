# Checks

- **Clean edges.** At 200% around the product, no fringe or halo from the old background. Hard edges stay hard.
- **Clean surfaces.** The backdrop's `luminance.contrast` is low and smooth after despeckling, with no specks at 100%. Labels and fine print stay sharp: compare their `sharpness`, and mask them out of despeckle layers.
- **Grounding.** The contact shadow is darkest right under the product, and fades within a short distance. Its colour is neutral (`color.cast` near neutral) unless the floor is coloured.
- **True colour.** Sample the product's brand colours and compare them with the reference values; aim for within ΔE 3.
- **Marketplace rules.** Check the background is pure white where required: sample its corners, which should read #FFFFFF. Check the product fills the frame by the required margin.
