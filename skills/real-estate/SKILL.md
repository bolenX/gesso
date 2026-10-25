---
name: real-estate
description: Architecture and real-estate photo workflows in Gesso (flambient blending, vertical correction, window views, colour casts, sky replacement, de-cluttering, lawns, twilight conversion, floor reflections, HDR-style interiors), as layered recipes.
---

# Architecture and real estate

Import the brackets or flash frames as image layers on one artboard at the same frame, in the order below.

## 21. Flambient blending

1. **Ambient** is the base.
2. Above it, **flash** in `luminosity` blend: clean, neutral light and detail without the flash's harsh colour.
3. For colour, a second flash copy in `color` blend at 0.3–0.6, masked where the ambient's colour is muddy: walls, ceilings.
4. Unify with `color-balance` (neutralise warm bulbs: highlights `[-10, 0, 15]`) and `curves`.

## 22. Vertical correction

1. `lens-correction` `distortion` to straighten bowed lines (try ±10–20).
2. Fix keystoning with `quad` on the photo layer: pull the top corners outwards until the verticals are vertical. Corners are in artboard pixels, e.g. top-left `[-60, 0]`, top-right `[w + 60, 0]`, bottoms at the frame's corners.
3. Crop by making the frame larger than the artboard, or use `"fit": "cover"` in a frame.

Check with a thin vertical guide line (a 1 px shape layer) next to a door frame, then delete it.

## 23. Window view recovery

Put the exterior-exposed frame above the interior-exposed one, masked with a `luminosity` lights mask (`level` 2–3, `source` set to the interior layer) so only the blown windows take the exterior.

Tighten the mask edge with the window shapes as vector masks if light spills. Match its brightness with `curves` clipped to it.

## 24. Colour casts

- **Selective desaturation:** `hue-saturation` `ranges` on the offending colour (e.g. `yellows: { saturation: -40 }`), masked to the walls or ceiling bounce.
- **White balance by area:** `curves` with `red` / `blue` channel curves, masked.
- **Global:** `match-color` with `neutralize: true` on a stamp, at `fade` 30–50.

## 25. Sky replacement

1. Mask the sky out with a `channel` mask (the blue channel, `black` 120, `white` 200, inverted) or `color-range` on the sky colour.
2. Put the new sky image below it, `fit: "cover"`, anchored at the top.
3. Ground colour shift: `photo-filter` in the sky's warmth (warm sunset `#EC8A00` at 20%), masked to the ground.
4. Light wrap: the sky blurred 30 in `screen` at 0.2 along the roofline.

Match the direction of the light: if the sun in the new sky is on the wrong side, flip the sky.

## 26. De-cluttering

- **Power lines and wires:** `heal` spots along the line (narrow, overlapping), or `content-aware-fill` for sky.
- **Cars, signs, bins:** `content-aware-fill` spots for small items. For big ones, `gen_prepare` `fill` with no prompt (Remove).
- **Exit signs:** `clone` from a clean patch of the same wall.

## 27. Lawn and landscaping

- **Patchy grass:** `clone` spots from healthy grass, or a grass texture image layer masked to the lawn, in `soft-light` 0.6, with `blendIf` `underlying: [30, 60, 255, 255]` to keep shadows.
- **Greens:** `hue-saturation` `ranges: { yellows: { hue: 15, saturation: 15 }, greens: { saturation: 10 } }`.
- **Matching tones:** `selective-color` `greens`.

## 28. Day to twilight

1. Darken the day image with `exposure` −1.5 and `color-balance` shadows towards blue `[-20, 0, 30]`.
2. Replace the sky with a dusk sky (see 25).
3. Window glow: warm orange shapes (`#FFB347`) over each window in `screen` or `linear-dodge`, with `gaussian-blur` 8–20 and `outer-glow`.
4. Lamps: small ellipses with `outer-glow`. Spill: big blurred warm shapes in `soft-light` on the ground near the doors.

## 29. Floor reflections

1. Stamp the room, `flip` it vertically and place it below the floor line with `quad` (mirror the perspective).
2. Add `motion-blur` (angle 90, distance 20–40), in `soft-light` at 0.3–0.5.
3. Mask it to the floor, fading out with distance (a gradient-like feathered mask).

## 30. HDR-style interiors

Exposure fusion by masks instead of tone mapping:

1. Put the brackets in order: dark (for windows), then mid, then bright.
2. Hand-held? `canvas_align` with the mid frame as `reference`.
3. `canvas_stack` with all the brackets and `mode: "exposure"`: each frame gets a mask that weights its well-exposed, saturated, contrasty pixels (Mertens exposure fusion).
4. Or by hand, with `luminosity` masks: the dark frame where `source: <mid>` is in the lights (`level` 2), the bright frame where the mid is in the darks.
5. Local contrast: `camera-raw` `clarity` 20–30 on a stamp, or `high-pass` 20 in `soft-light` at 0.3.

Keep it natural. Check that shadows still read as shadows.
