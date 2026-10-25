# Checks

Render every artboard side by side at a small scale. Then check each size:

- **Preflight.** Run `canvas_inspect` with `preflight: true` on each artboard. There should be no errors: no text or logo cut off at the edge. On sizes with a preset that has safe zones (stories, reels, TikTok), there should be no warnings about the safe-zone margins either.
- **Hierarchy survives.** The headline is still the largest text and the call to action is still visible on every size. On the smallest sizes, type stays at or above the preflight minimum.
- **Nothing is squeezed.** Images keep their proportions, and faces and products aren't cropped at their edges. Check the subject's position with a `region` render if it's near an edge.
- **Generated extensions don't show.** Where a background was extended (`gen_prepare` expand), zoom to 100% on the seam. Tone and texture should continue with no line, and there should be no repeated objects.
- **Every size looks designed for itself.** A portrait story shouldn't look like a landscape with bars, and a banner shouldn't look like a shrunk poster.
