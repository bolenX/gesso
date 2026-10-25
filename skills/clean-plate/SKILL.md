---
name: clean-plate
description: Clean plates: removing the subject (or clutter) from a background so it can be reused, extended and re-composed, with content-aware fill or a generative job.
---

# Clean plate

A clean plate is the background without the subject. You need one to:
- move or resize the subject without leaving a ghost
- extend a background without echoing the product at its edges
- reuse a photo's setting

## Build it

1. **Small or simple subjects** (a person against sky, a product on a seamless backdrop, signs, cars): apply `clean-plate` with spots covering the subject, a little larger than it. It's a live content-aware fill on a copy of the photo.
2. **Big subjects or complex backgrounds:** use `gen_prepare` `fill` with no prompt (Generative Remove) on the photo, with regions over the subject. Run it with the user's image tool, and import the result as the plate.
3. **Keep the plate below the subject.** A clean plate plus a cut-out of the subject (`remove-background` job) gives two independent layers.
4. **Check at 100% for repeats.** Content-aware fill copies patches; repeated texture (the same stone, the same cloud) gives it away. Heal over obvious repeats with `heal` spots.

## Spots

Spots are fractions of the layer's box: `at` is the centre and `size` the width and height. Use `"shape": "rect"` for boxy subjects. Several overlapping spots can cover irregular shapes.
