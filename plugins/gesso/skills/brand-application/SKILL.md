---
name: brand-application
description: "Brand application: applying a brand's colours, fonts and logo rules to a layout by layer role, consistently across every size."
---

# Brand application

Brands are applied through roles, not by hand: give every layer a `meta.role`, and the brand follows the roles.

## Roles

| Role | What it is | Brand property |
| --- | --- | --- |
| `background` | backdrop shapes | primary or neutral colour |
| `headline` | main text | brand font, strongest colour |
| `body` | supporting text | brand font, text colour |
| `cta` | button shape | accent colour |
| `decoration` | bars, shapes, patterns | secondary colour |
| `logo` | the logo | never recoloured; clear space around it |

Set roles with `canvas_patch` (`set` `meta.role`), then apply `apply-brand` with the palette and font. It updates every layer of each role, on every artboard.

## Rules to keep

- **Logo:**
  - Use the supplied artwork, never retyped or redrawn.
  - Keep clear space around it of at least the height of its mark.
  - Never stretch it. Keep its frame's aspect ratio.
- **Colour:**
  - Use hex values from the brand guide, not sampled ones.
  - Check the accent against the background for contrast: a CTA should stand out.
  - In print, use the brand's CMYK values via a CMYK export with the profile.
- **Type:**
  - Only the brand's fonts, in the weights it specifies.
  - Find them with `font_list`, or import them with `asset_import`.
- **Imagery:** tone photos consistently. A `duotone` or a shared grade above them all works well.
