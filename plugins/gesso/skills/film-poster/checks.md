# Checks

- **Thumbnail test.** Render at a scale that makes the poster about 200 px wide (scale 0.1 for a 2025-wide one-sheet). The face and the title must still read, as they would in a streaming grid.
- **Reading order.** At that size you see the face first, then the title, then the date. If the billing block or tagline jumps out first, make it smaller or quieter.
- **The title stands off the art.** Sample behind the title with `canvas_inspect`: its luminance should differ from the title's colour by at least 50 levels. Strengthen the scrim or add a glow if not.
- **No type over eyes.** Faces are the hook: keep the names, tagline and title off the eyes and mouth. Check the frames against the face in a render.
- **Skin survives the grade.** After an orange-and-teal or cold grade, sample a cheek: its vectorscope angle should stay within 15° of the skin line (`fromSkinLine`).
- **One grade, one grain.** Composited parts share the same grade and grain; zoom to 200% on an edge between them and look for a change in noise or colour.
- **Billing block.** One block, centred, no taller than a tenth of the poster, nothing smaller than preflight's minimum (`preflight: true` gives no small-type warning).
- **Print.** For print, the artboard is at least 150 dpi at full size, type sits at least 3% inside the trim, and the PDF export has `bleed: 3.2` (1/8 in).
