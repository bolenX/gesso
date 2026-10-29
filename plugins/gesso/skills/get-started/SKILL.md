---
name: get-started
description: First steps with Gesso, the layered image editor (what it can do, how to bring in the user's own photos and fonts, and a first design to try). Use when someone has just connected Gesso, asks what it can do, or doesn't know where to start.
---

# Get started with Gesso

Gesso builds images as named layers (text, shapes, photos, adjustment layers, masks and layer styles) and exports PSDs that open in Photoshop with those layers still live. It also exports PNG, JPEG, WebP, TIFF, SVG and print PDF. Every change is a revision that can be undone.

## When someone first connects

1. **Say what it does, in a sentence or two.** It designs posters, social posts and banners, adapts one design to other sizes, retouches and grades photos, makes cut-outs, and exports editable PSDs.
2. **Check for earlier work.** Call `canvas_list`. If there are documents, offer to continue one.
3. **Offer a first project** that fits what they asked for, or one of these:
   - "Make a 1080×1350 poster for [event] with a bold headline, show me a preview, then export a PSD."
   - "Adapt my poster to an Instagram story, a square post and a YouTube thumbnail."
   - "Retouch this portrait: even the skin, brighten the eyes, warm the shadows, then compare before and after."

## Bringing in their files

- **Photos, fonts and PSDs:** Gesso's instructions say how this server takes files. On the hosted server there's an upload page link; on the user's own computer, files go in their Gesso folder. Then call `asset_import` with the path.
- **From the web:** `asset_import` also takes an image URL.
- **A PSD to edit:** `psd_import` opens it as an editable document.

Ask for a file before editing; don't invent one.

## How to work

- Read a document with `canvas_outline` and change it only with `canvas_patch`.
- For a task with a matching skill (adapting sizes, retouching, cut-outs, compositing, duotone and so on), read it with `skill_read` first. Many skills have recipes that `skill_apply` sets up in one step.
- Before saying it's done, look: `canvas_render` a preview, zoom into detail at 100–200%, and compare with the revision before.
- Export with `canvas_export`. Each export comes back as a file or a download link.

## What Gesso doesn't do

Gesso renders everything itself and doesn't generate images with AI. For a generated background or a fill, `gen_prepare` writes a job for an image tool the user has connected separately; without one, say so and offer to design it from shapes, gradients and their own photos.
