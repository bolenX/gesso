---
name: typography-hierarchy
description: Typography hierarchy: a modular type scale (headline, subhead, body), line lengths, leading and tracking, set as live text layers.
---

# Typography hierarchy

Readers scan before they read. Size, weight and position tell them what matters.

## The scale

Pick a base size (the body) and a ratio, then size each level as base × ratio^n:

| Ratio | Feel | Body → subhead → headline (base 32) |
| --- | --- | --- |
| 1.25 (major third) | calm, editorial | 32 → 40 → 62 |
| 1.333 (perfect fourth) | balanced, default | 32 → 43 → 76 |
| 1.5 (perfect fifth) | bold, posters | 32 → 48 → 108 |
| 1.618 (golden) | dramatic | 32 → 52 → 136 |

The `type-scale` recipe sets all three levels from a base, a ratio and a font, stacked within the margins.

## Rules

- **Base size.** On 1080 px social formats, use at least 32 px for body text, and 28 px for fine print. In print at 300 dpi, body text is 9–11 pt (38–46 px).
- **Weight before size.** A bold subhead at a small size often beats a large regular one. Use two weights at most, three for complex layouts.
- **Leading.** Body text at 1.3–1.5× its size; headlines tighter, at 1.0–1.15×. Gesso's `style.leading` is in px.
- **Tracking.** Headlines slightly negative (−10 to −20 per thousand); all-caps labels positive (+50 to +100).
- **Line length.** Body text at 45–75 characters per line. Narrow the text frame instead of shrinking the type.
- **One alignment.** Left-align by default. Centre only short, symmetrical layouts.
- **Contrast.** Headline against background: the strongest contrast on the page.
