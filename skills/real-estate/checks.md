# Checks

- **Verticals are vertical.** Door frames and wall edges are straight up and down: zoom into one with a `region`.
- **Neutral colour.** White walls and ceilings sample neutral, with R, G and B within about 5 of each other. `color.cast` on a wall region reads "neutral" or "slightly warm".
- **Windows.** The windows show the view, not white: `clipped.highlights` in a window region stays under about 5%. There's no dark halo where the window frame meets the wall.
- **Believable light.** Rooms aren't flat. Corners and floors stay a little darker than walls facing the light.
- **Skies and lawns** look natural. The sky's light matches the scene, and grass is green but not neon (`color.chroma.p99` under about 70 on the lawn).
- **Twilight.** The sky is blue to orange, the house is darker, and every window glows warm.
