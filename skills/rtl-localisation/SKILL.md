---
name: rtl-localisation
description: "Right-to-left localisation (Arabic, Hebrew, Persian, Urdu): text direction, mirroring the layout, fonts that cover the script, and numbers."
---

# Right-to-left localisation

Localising into an RTL language means more than translating: the reading direction flips, and so does the layout.

## Text

- **Direction.** Set `direction: "rtl"` on each translated text layer, and `style.align` to `start` (in RTL, start is the right side).
- **Fonts.** Use a font that covers the script: Noto Sans Arabic, Noto Naskh Arabic, IBM Plex Sans Arabic, Noto Sans Hebrew. Find one with `font_list` (for example, query "arabic"). A Latin-only font shows boxes.
- **Size.** Arabic often needs 10–20% more size than Latin at the same visual weight, and more leading, because of its ascenders and descenders.
- **No tracking.** Never letter-space connected scripts; it breaks the joins.
- **Numbers.** Keep Western digits unless the user asks for Eastern Arabic ones (٠١٢٣). Prices keep their currency's convention.
- **Mixed text.** Embedded Latin brand names and numbers run left to right inside RTL text. That's correct; don't reverse them.

## Mirroring the layout

Mirror the reading flow:
- Logo from top left to top right.
- The text column to the right.
- Arrows and "next" icons flipped (`flip: "horizontal"`).
- Progress or timelines running right to left.

To mirror a layer with an absolute frame on an artboard W wide, set `frame.x = W − x − w`. Don't mirror:
- photos, unless the composition demands it (faces looking into the text are fine either way)
- logos and brand marks
- charts with time axes, unless the brand's guide says so
- media controls

## In PSD

RTL paragraph direction isn't written to PSD yet: Photoshop opens the text left to right. Mention it when handing over a PSD.
