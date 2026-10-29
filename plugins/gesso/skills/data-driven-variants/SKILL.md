---
name: data-driven-variants
description: "Data-driven variants: one template filled from rows of data (names, prices, photos) into many outputs with canvas_batch, like Photoshop's Variables."
---

# Data-driven variants

Like Photoshop's Image › Variables: one template, many outputs, each filled from a row of data. Use it for:
- price cards and product tiles
- event badges and name cards
- personalised social posts

## Build it

1. **The template.** Design one artboard with stable layer ids for everything that varies: `name`, `price`, `photo` and so on. Make the text layers area text with `shrinkToFit` and a `minSize` (typography-reflow skill), so long values still fit.
2. **The data.** One row per output:

   ```json
   [{ "name": "spring", "headline": "Spring Sale", "price": "€29", "photo": "photos/spring.jpg" }]
   ```

   - Keys are layer ids. Text layers take the text; image layers take a path (or URL) to an image.
   - `name` names the output file.
3. **Run** `canvas_batch` with `rows`, an `outDir` and a format. For a folder of images into one image layer, use `sources` and `layer` instead.
4. **Spot-check** the first, the last and the longest row's output.

## Tips

- **Formats.** PSD gives an editable file per row. PNG or JPEG gives finished assets.
- **Longest value first.** Design the template with the longest value in the data, not the shortest.
- **Images with different aspect ratios** need `fit: "cover"` and a `focus` that works for all of them, or a `contain` frame on a neutral backdrop.
