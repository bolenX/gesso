---
name: social-campaign-set
description: Social campaign sets: one master design adapted to every channel size (feed, story, reel, banner) with shared smart objects, roles and per-size checks.
---

# Social campaign set

A campaign set is one idea delivered at every size a channel needs. Build the master once, then adapt it.

## Build it

1. **Master.** Start from the size with the most content, usually 1080×1350 (4:5). Give every layer a role: background, subject, headline, body, cta, logo.
2. **Shared elements.** Make the hero image and the logo smart layers (symbols). One change updates every size.
3. **Sizes.** Use `artboard_create` with `from: <master>` and a preset for each size. A common set:
   - 1080×1080 (square)
   - 1080×1350 (portrait)
   - 1080×1920 (story and reel)
   - 1200×628 (landscape)

   See the channel-packs skill for full channel lists.
4. **Re-place per size.** Adapting re-places layers by their edges and roles. Then fix each size by hand with `canvas_patch`:
   - Stories need the text higher, out of the bottom 340 px.
   - Landscape needs the headline beside the image, not below it.
5. **Extend backgrounds** that are too small for a size with one shared `gen_prepare` expand job. See the adapt-sizes skill.

## Rules

- **Same message, same order.** Every size shows the same headline and CTA. Drop the body text on the smallest sizes before shrinking the headline.
- **Safe zones.** Story and reel sizes have UI over the top and bottom. Preflight warns about it.
- **Name the artboards** by channel and size (`ig-story-1080x1920`), so exports are self-explanatory.
