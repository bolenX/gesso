---
name: film-poster
description: "Film poster design: one-sheets, teasers and key art (poster types by genre, the layout from names above the title to the billing block, title treatments, grading for blockbuster, thriller and indie looks, atmosphere and light), in the standard formats, with the checks a studio would make."
---

# Film posters

A film poster sells a feeling in one look: who's in it, what kind of film it is, and when it opens. Studios call the finished image the **key art** and the theatrical poster the **one-sheet**. Every one of them follows the same anatomy, and the genre decides the rest.

## Formats

| Format | Size | In Gesso |
| --- | --- | --- |
| US one-sheet | 27×40 in, portrait | preset `one-sheet` (2025×3000 key art). For print, make it 4050×6000 (150 dpi) and export a PDF with `dpi: 150` and `bleed: 3.2` (1/8 in) |
| International | A1 (594×841 mm) or A0, 1:1.414 | A1 at 150 dpi is 3508×4967; preset `a3` for proofs |
| UK quad | 40×30 in, landscape | preset `quad` (3000×2250). Not a squeezed one-sheet: title and art sit side by side |
| Teaser | same sizes as the one-sheet | the `one-sheet` layout with less: art, title, date |
| Streaming and online | 2:3 box art (2000×3000), 16:9 key art (`hd`, `4k`) | 16:9 puts the title in the left or right third, beside the faces |
| Social | 4:5, 9:16 | `instagram-portrait`, `instagram-story`; drop the billing block |

Adapt one finished poster to the others with the adapt-sizes skill: rebuild, don't squeeze.

## Pick the poster type

| Type | What it is | Suits | How in Gesso |
| --- | --- | --- | --- |
| **Big head** | One face, huge, often cropped at the forehead | drama, biopic, thriller | the portrait filling the art, `focus` on the eyes, title below the chin: if the title lands on the mouth, move the image up, not the title |
| **Ensemble** | Faces stacked in a column or pyramid, the lead largest and highest | action, heist, franchise | each face a cut-out (cutouts skill) in its own frame, overlapping, one shared grade over all |
| **Small figure, big world** | A tiny figure in a vast landscape or city | sci-fi, adventure, survival | the figure under 10% of the height, on a third, with `atmosphere` haze between it and the camera |
| **Silhouette** | A dark shape against a bright sky or light | thriller, western, war | the subject cut out and filled black, a gradient sky, `atmosphere` glow behind it |
| **Iconic object** | One symbol on a plain field: a key, a mask, a shoe | horror, mystery, festival films | the object centred small, 60% or more negative space, a quiet title |
| **Typographic teaser** | The title or a date is the whole poster | teasers, sequels | the title huge (a 0.3 `titleSize`), a texture behind it, nothing else |
| **Graphic** | Flat shapes and two or three inks, Saul Bass style | auteur, retro, re-releases | vector shapes with a `duotone`, cut-paper edges, a hand-made title |
| **Split** | Two halves: two faces, two worlds, before and after | romance, dual leads, twist films | two masked image layers meeting on a line or the title |

## Genre cues

| Genre | Colour | Title | Composition |
| --- | --- | --- | --- |
| Action, blockbuster | orange skin, teal shadows, high contrast (`blockbuster-grade`) | wide or condensed caps, metallic (`title-metal`) | ensemble, diagonals, sparks and smoke |
| Thriller, crime | cold, desaturated, crushed shadows (`thriller-grade`), one red accent | condensed sans, tight | big head or silhouette, faces half in shadow |
| Horror | near black, one cold or sick colour | thin, spaced or distressed | iconic object, a lot of empty dark, tagline at the top |
| Sci-fi | deep blue and cyan, glows | extended or geometric sans | small figure, big world, light beams |
| Drama, indie | muted, warm or natural, film grain | small serif or light sans, lots of space | big head or a quiet scene, the title small |
| Romance, comedy | bright, warm; comedies often white | friendly serif or rounded sans | two people, close; comedies smiling at the camera |
| Animation, family | saturated, sunny | bouncy, chunky display type | the characters large, playful angles |

## The layout, top to bottom

The `one-sheet` recipe sets this up over your key art, in proportion to the artboard:

1. **Names above the title:** the stars, small caps, wide tracking (about 2.4% of the width, tracking 200).
2. **Tagline:** one line, smaller and quieter, near the top or just above the title.
3. **Key art:** the image, about two thirds of the height.
4. **Title treatment:** the second-biggest thing after the faces, in the lower third, 12–18% of the width tall. It must read at thumbnail size.
5. **Release line:** "ONLY IN THEATERS · DECEMBER 18" or "COMING SOON", wide-tracked caps under the title.
6. **Billing block:** the credits, at the bottom, in condensed caps.
7. **Logos and rating:** studio logos and the rating box beside or under the billing block.

**Reading order:** face, then title, then date. Squint at a small render to check it.

## Title treatment

- **Fonts:** condensed or extended caps for action and sci-fi, serif for drama and romance, thin or broken type for horror. On the shared server, `font_list` with "Bebas" (condensed caps), "DM Serif Display", "IBM Plex Serif", "Space Grotesk" or "Poppins".
- **Size and fit:** set the title's box to `{ "kind": "area", "shrinkToFit": true }` (the recipe does) so a long title still fits the width.
- **Tracking:** tight for big condensed titles (0–40), wide for small spaced titles (300–600).
- **Metal:** `title-metal` gives a polished gradient, a bevel and a shadow. Pass `metal` stops for gold: `[{"offset":0,"color":"#6B4A12"},{"offset":0.45,"color":"#F7E3A1"},{"offset":0.55,"color":"#A7781E"},{"offset":1,"color":"#F3D58A"}]`.
- **Texture in the title:** put a texture image directly above the title and set `clip: true` on it (rust, concrete, film frames).
- **Glow:** add an `outer-glow` effect in the genre colour, 10–20% of the type size, opacity 0.4–0.6.

## Billing block

The credits in tight condensed capitals, one colour, centred, about 76% of the poster's width, and no taller than a tenth of it:

- **Order:** studio "presents", production company, the film's title, "starring" and the cast, then music, editing, photography, design, producers, writer and director.
- **Role words are smaller.** Photoshop users set "DIRECTED BY" at about half the size of the names. In Gesso, give the layer `runs`: `[{ "text": "DIRECTED BY " , "size": 20 }, { "text": "ELENA MARSH ", "size": 40 }, …]`, whose texts join to the layer's `content`.
- **Font:** Univers Ultra Condensed is the classic; Bebas Neue, Oswald or League Gothic stand in. `font_list` with "condensed" finds others.
- Keep it in one block. Don't break it around the art.

## Building the key art

Bottom to top:
1. **Background plate:** a sky, a city, a landscape. Missing one? `gen_prepare` writes a job for the user's own image tool.
2. **Subject:** cut out with the cutouts skill (hair and fur solved), placed with its eyes on the upper third.
3. **Atmosphere:** `atmosphere` adds fog and a light source behind the subject, which separates it from the background.
4. **Light:** `relight` or `lighting-effects` for a key light that matches the background; `lens-flare` sparingly.
5. **Grade:** one grade over everything (`blockbuster-grade` or `thriller-grade`, or the adjustments skill), so every part looks shot together. Then sample a cheek with `canvas_inspect`: a cold or teal push that reaches the skin turns faces grey or blue, so pull it back to the shadows.
6. **Grain:** the grades add film grain on top, which also hides seams between composited parts.
7. **Type:** the `one-sheet` recipe, then `title-metal` if the genre wants it.

## Recipes

| Recipe | What it does |
| --- | --- |
| `one-sheet` | The type layout over the key art: names, tagline, bottom scrim, title, release line and billing block |
| `blockbuster-grade` | Orange and teal: teal shadows, warm highlights where the skin sits, neutral mid-tones, punchy contrast, vibrance, vignette and grain |
| `thriller-grade` | Cold and desaturated: muted colour, a blue cast in the shadows only (skin stays a muted neutral), crushed shadows, a heavy vignette and grain |
| `atmosphere` | Fog rising from the bottom and a glow behind the subject, both in screen |
| `title-metal` | A polished metal title: gradient overlay, bevel and drop shadow |

## Rights

Use the user's own images and fonts, or ones licensed for this use. Don't put real studio logos, rating marks or real actors' names on a poster for a film they're not in, and don't recreate a real film's key art to pass it off as official.
