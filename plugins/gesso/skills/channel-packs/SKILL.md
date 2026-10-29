---
name: channel-packs
description: "Channel packs: the sizes, formats and file-size limits each channel needs (Meta, Instagram, TikTok, LinkedIn, X, YouTube, Pinterest, display ads, email), and how to export to them."
---

# Channel packs

A channel pack is every size a channel asks for, exported in its formats and within its file-size limits. Platform specs change, so confirm current limits with the user or the platform's documentation when it matters.

## Common packs

| Channel | Presets (`artboard_create`) | Format | Typical size limit |
| --- | --- | --- | --- |
| Instagram | `instagram-square`, `instagram-portrait`, `instagram-story`, `instagram-reel` | JPEG (photos), PNG (graphics with text) | ~8 MB |
| TikTok | `tiktok` | JPEG or PNG | ~5–10 MB |
| Facebook | `facebook-post`, `facebook-cover`, plus the Instagram sizes for ads | JPEG | ~30 MB for ads |
| LinkedIn | `linkedin-post` | JPEG or PNG | ~5 MB |
| X | `x-post`, `x-header` | JPEG or PNG | ~5 MB |
| YouTube | `youtube-thumbnail` | JPEG | 2 MB |
| Pinterest | `pinterest-pin` | JPEG or PNG | ~20 MB |
| Display ads (IAB) | `iab-300x250`, `iab-728x90`, `iab-300x600`, `iab-160x600`, `iab-320x50`, `iab-970x250` | JPEG, PNG or WebP | often 150 KB |
| Email | a 600 or 1200 px wide artboard | JPEG or PNG | under ~1 MB each |
| Open Graph | `og-image` | JPEG or PNG | ~5 MB |

## Exporting within limits

- Export with `canvas_export`, then read each file's size in the manifest.
- **Over the limit:**
  - lower the JPEG or WebP quality (start at 85, then 75)
  - use WebP where it's accepted
  - use PNG only for flat graphics
- **Display ads at 150 KB:** keep backgrounds flat or simple. Busy photo backgrounds compress badly.
- **Retina:** export at `scale: 2` where a platform shows images at double density (email, web).
- **Colour:** always RGB for screens. CMYK is only for print.
