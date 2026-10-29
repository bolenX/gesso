---
name: extreme-ratio-relayout
description: "Relayout for extreme ratios: turning a layout into very wide banners (8:1 leaderboards) or very tall ones (skyscrapers, stories) by restructuring, not scaling."
---

# Extreme-ratio relayout

A 4:5 poster can't become a 728×90 leaderboard by scaling: the content has to be rearranged.

## Ratio classes

| Class | Ratio (w:h) | Layout |
| --- | --- | --- |
| Tall | below 0.6 (stories, 160×600) | stack vertically: logo, image, headline, CTA |
| Portrait and square | 0.6–1.3 | the master layout |
| Wide | 1.3–3 (landscape, OG) | image on one side, text on the other |
| Very wide | above 3 (728×90, 970×250, X header) | one row: logo, headline, CTA left to right; image as a strip or dropped |

## Steps

1. **Adapt first.** Use `artboard_create` with `from` to get every layer onto the new artboard with roles kept.
2. **Restructure** with `canvas_patch`, for each ratio class:
   - **Very wide:**
     - Put the headline on one line, sized to the height: the cap height is about 35–45% of it.
     - Put the CTA at the right end.
     - Put the logo at the left.
     - Crop the image to a narrow strip, or drop it.
   - **Tall:**
     - Stack the layers, each spanning the width.
     - Give the image the middle third.
     - Use larger type than you would on a square.
3. **Drop what doesn't fit.** On a 320×50 mobile banner, show only the logo, a 3–5 word headline and the CTA. Remove the body text (`remove`), rather than shrinking it until it's unreadable.
4. **Check** each size alone at 100%: banners are seen small.
