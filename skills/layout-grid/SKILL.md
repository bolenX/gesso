---
name: layout-grid
description: Layout and grid systems: margins, columns, gutters and baseline rhythm for posters, social and print, with guide layers to place against.
---

# Layout and grid systems

A grid makes layouts feel deliberate and lets several sizes share one system.

## Setting up

- **Margins:** 6–8% of the width on social and posters; 10–15 mm in print, plus bleed.
- **Columns:**
  - **12:** flexible. Halves, thirds, quarters.
  - **6:** simpler social layouts.
  - **4:** narrow banners.
- **Gutters:** 2–3% of the width, about equal to the body text's line height.
- **Baseline:** the body text's leading. Space vertical gaps in multiples of it.

The `column-guides` recipe adds a "Grid guides" group with one tinted column per step, tagged `guide`. It shows the grid in renders while you place layers. Delete it (`remove` with `".guide"` and `many: true`, then the group) or hide it before exporting.

## Placing on the grid

- **Column positions:** column k starts at margin + k × (column width + gutter). A span of n columns is n × column width + (n − 1) × gutter wide.
- **Snap** every layer's x and width to column edges, and every y to the baseline.
- **Images** span whole columns. Let a full-bleed image break the grid deliberately.
- **Text** starts on a column edge. A headline often spans 8–12 columns, body text 6–8.
- **Across sizes:** keep the same margins in proportion, and reduce columns on narrow formats (12 → 6 → 4).
