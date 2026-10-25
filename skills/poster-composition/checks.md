# Checks

- **The reading order is clear.** Squint at a small render (scale 0.25): you should see the hero, then the headline, then the action.
- **Text is legible.** Sample behind each text block with `canvas_inspect`. The background's luminance should differ from the text colour's by at least 50 levels. Add or strengthen a scrim if not.
- **Preflight.** `preflight: true` reports no errors and no safe-zone warnings.
- **Margins are consistent.** Elements line up on the same margins. Check their frames in `canvas_outline`.
