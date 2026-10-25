---
name: typography-reflow
description: Typography reflow across sizes: area text that shrinks to fit with a minimum size, line breaks, and when to cut copy instead of shrinking it.
---

# Typography reflow

When a layout changes size, its text has to re-break and sometimes resize. Do it deliberately.

## Area text

Give text that must fit a box an area box:

```json
{ "op": "set", "target": "#headline", "path": "box", "value": { "kind": "area", "shrinkToFit": true, "minSize": 48 } }
```

The `fit-text` recipe does this. The text wraps within the frame and shrinks only as far as `minSize`; below that it overflows, and render warnings say so. Set `minSize` from the hierarchy: never below the next level's size, or the headline stops reading as a headline.

## Line breaks

- **Break by sense,** not by width. "Summer sale / ends Sunday" beats "Summer sale ends / Sunday". Put manual breaks (`\n`) in the content for headlines.
- **No orphans.** A last line of one short word looks broken. Rewrap, or adjust the frame width by a few percent.
- **Rag.** Keep the right edge of left-aligned text roughly even. Avoid a long line followed by a short one in headlines.

## When the text doesn't fit

In this order:
1. Rewrap: change the line breaks.
2. Widen or heighten the frame.
3. Shrink to `minSize`.
4. Cut copy. Drop the subhead on the smallest sizes, rather than shrinking everything.

Ask before cutting the user's copy.
