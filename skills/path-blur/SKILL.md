---
name: path-blur
description: Add a curved motion / path blur to a photo, Photoshop Blur Gallery style, while keeping the subject sharp.
---

# Path blur

Use this for "path blur", "motion blur", "speed blur", "movement" or "dynamic blur" on a photo. The blur flows along a curve you choose; a sharp copy shows through where the subject is.

## Build it

1. Keep the original photo layer as it is. It stays sharp underneath.
2. Insert a copy right above it (same `asset`, `fit`, `focus` and `frame`) with a new id such as `photo-blur`, and give it the blur:

```json
"filters": [{ "kind": "path-blur", "path": [[0.0, 0.62], [0.35, 0.52], [0.7, 0.55], [1.0, 0.4]], "distance": 120 }]
```

- **`path`**: points as [x, y] fractions of the layer's box, in the direction of motion, at least two. A gentle S or arc across the frame looks natural; follow the subject's movement (a walking person, a passing train, a turning head).
- **`distance`**: blur length in pixels. 3–6% of the image width is a soft sense of motion; 8–12% is strong speed.
- For a straight blur use `{ "kind": "motion-blur", "angle": 0, "distance": 120 }` instead (angle 0 is horizontal).

3. Keep the subject sharp with a soft, inverted mask on the blurred copy over the face or product:

```json
"mask": { "kind": "vector", "shape": { "kind": "ellipse" }, "frame": { "x": 820, "y": 300, "w": 420, "h": 560 }, "feather": 80, "invert": true }
```

The mask frame is in the layer's coordinates. Use a large `feather` (10–20% of the ellipse size) so the sharp area melts into the blur, as with Photoshop's soft brush.

4. Render and check that the subject's eyes or product edges are sharp and that the blur reads as movement, not as a mistake. Adjust the ellipse to the subject, and the `distance` if it looks too smeared.

## Variations

- **Subject blurred, background sharp** (the subject is moving): blur the subject's layer instead, or drop `invert` so the mask shows the blur only inside the ellipse.
- **Several directions**: use more path points; the blur bends with the curve, following the nearest part of the path.

## In Photoshop

The PSD has both layers: the sharp original and the blurred copy with its mask (the mask stays editable). The blur itself is in the copy's pixels.
