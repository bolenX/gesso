# Checks

- **Preflight.** `canvas_inspect` with `preflight: true` shows no type under the minimum size and no text past the artboard.
- **Hierarchy.** Each level is at least one ratio step larger than the next. In a small render (scale 0.25), the headline is clearly first.
- **No collisions.** Text frames don't overlap unless that's intended. Check the frames in `canvas_outline` and render at 100%.
- **The text fits.** Render at 100%: there's no clipped last line in any text frame. Use an area box with `shrinkToFit` and a `minSize`, or enlarge the frame.
