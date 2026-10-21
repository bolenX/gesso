---
name: adapt-sizes
description: Adapt one master composition to many sizes (1:1, 4:5, 9:16, 16:9) by cropping first and generating only the remainder, once, as a shared plate.
status: placeholder
---

# adapt-sizes (flagship, v0.1)

> Placeholder. A senior practitioner should write the workflow, judgement calls and failure modes while the engine is being built.

## Pipeline

1. **Analyse:** find the focal point, the subject mask (segmentation) and the platform safe zones.
2. **Plan:** for each target, scale first, then use the crop budget, then work out what's still missing on each axis.
3. **Union:** the super canvas is the bounding box of everything that's missing.
4. **Clean plate (optional):** inpaint the subject out so the expansion never repeats the product at the edges.
5. **Generate:** run one expand job through the broker. Split it into stages when the expansion is more than roughly 50% per side.
6. **Crop:** each artboard takes its window from the shared plate, held as a linked smart object.
7. **Reflow:** place the foreground layers again by anchors and safe zones. Never bake them into the background.
8. **Check:** render all artboards side by side. Check seams, subject integrity and safe zones, and make sure no objects are duplicated.

## Required primitives

Expand broker, segmentation, linked smart objects, anchor frames.
