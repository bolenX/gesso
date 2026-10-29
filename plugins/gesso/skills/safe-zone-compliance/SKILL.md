---
name: safe-zone-compliance
description: "Safe-zone compliance: keeping text, logos and buttons clear of platform UI (story bars, captions, buttons) and checking it with preflight."
---

# Safe-zone compliance

Platforms draw their own interface over full-screen formats: profile bars at the top, captions, buttons and progress bars at the bottom. Anything important under them is hidden.

## Safe zones in Gesso

Artboards made from a preset with safe zones carry the preset in `artboard.preset`. `canvas_inspect` with `preflight: true` then warns about every text, logo, headline, body and CTA layer that reaches into the margins.

| Preset | Keep clear (top, right, bottom, left, px) |
| --- | --- |
| `instagram-story` | 250, 60, 340, 60 |
| `instagram-reel` | 250, 120, 420, 60 |
| `tiktok` | 160, 140, 480, 60 |
| `youtube-thumbnail` | the timestamp corner: 110 px at the bottom right |

## Working with them

- **Design inside the safe area first:** headline, CTA and logo. Let only backgrounds and imagery run to the edges.
- **Fix warnings with `canvas_patch`:** move a layer inwards, or shrink its frame. Re-run preflight until it's clean.
- **On sizes without a preset** (a custom ad size), keep 5% margins as a rule of thumb.
