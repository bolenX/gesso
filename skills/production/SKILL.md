---
name: production
description: Getting files out of Gesso for print and for teams: CMYK and ICC profiles with soft proofing, TIFF, print PDFs with bleed, asset-generator slices from layer names, batch runs over images or data rows, merging layers, and find and replace.
---

# Production

## Print

| need | how |
|---|---|
| CMYK TIFF or JPEG | `canvas_export` with `format: "tiff"` (or `jpeg`), `color: "cmyk"`, `profile: "cmyk"` (a standard press) or the path of the printer's `.icc` |
| check colours before printing | `canvas_render` with `proof: "cmyk"` (or the printer's profile). Out-of-gamut colours (bright greens, oranges, electric blues) show as they'll print. Tone them down with `hue-saturation` or `selective-color` if needed |
| a press-ready PDF | `canvas_export` with `format: "pdf"`, `bleed: 3`, `marks: true`. Print presets (A4, A5, Letter, posters) get 300 dpi. Backgrounds and images that touch the edge extend into the bleed |
| a different RGB space | `profile: "p3"` (Display P3) or an ICC path, with any format |

Notes:

- PSD and PDF stay RGB. Printers convert those, or send them the CMYK TIFF.
- Keep text 3–5 mm inside the trim, and make rich blacks deep (a `#0A0A0A` on a big area prints flat).

## Slices (Generate › Image Assets)

Name layers or groups like files, then export with `slices: true`:

| layer name | gives |
|---|---|
| `logo.png` | the layer alone, cropped to its pixels |
| `200% hero.png` | at twice the size (retina) |
| `hero.jpg80` | JPEG at quality 80 |
| `512x512 icon.png` | fitted into 512×512 |
| `icon.png, 200% icon@2x.png` | several files from one layer |

Files go to `<outDir>/assets/`. Adjustment layers below still apply; other layers are hidden.

## Batch runs and data merge

`canvas_batch` runs a document as a template:

- **One layout, many photos:** `{ "layer": "photo", "sources": "shots/" }`. Each image takes the photo layer's place, keeping its frame, fit, filters and effects. Files are named after the images.
- **Variable data** (cards, badges, localized banners): `{ "rows": [{ "name": "fr", "headline": "Soldes d'été", "photo": "fr.jpg" }, …] }`. Keys are layer ids: text layers take text, image layers take paths.
- **Formats:** PNG, JPEG, WebP, TIFF (with `color: "cmyk"`) or PSD (one per row).

Check one variant first: run with a single source or row, then render it. Watch for text that overflows.

## Merging, copying, replacing

- **`canvas_stamp`:**
  - no `layers`: Stamp Visible
  - `layers: [...]`: those layers only
  - `merge: true`: Merge Layers
  - `region`: a crop

  The pixels are saved as an asset and inserted as an image layer.
- **`duplicate` patch op:** copy a layer or group with a new id, optionally `offset` or placed `after` / `before` / `into` somewhere else.
- **`replace-text` patch op:** change wording everywhere at once, e.g. `{ "op": "replace-text", "find": "2025", "replace": "2026" }`, or a `regex` with `$1` groups. Styled runs keep their styling.

## Content-aware fit

For an image that has to fill a frame of a different shape without cropping the subject, set `"fit": "content-aware"` (Content-Aware Scale). It removes the least noticeable columns or rows. It works best with space around the subject (sky, floor, sea). Busy images can distort, so check the render.
