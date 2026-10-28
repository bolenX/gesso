---
name: cutouts
description: Cut-outs and masking for hard subjects (hair, fur, glass and clear liquids, smoke and powder, studio and product shots), with Gesso's matting, backdrop and clean-plate keys, chokes and spreads, glass rebuilt from blend modes, and a check loop that measures halos.
---

# Cut-outs and masking

A cut-out is finished when its edge holds up on any background: no halo of the old one, hair that keeps its wisps, glass you can see through. Get there in three moves: a rough mask, an edge solved from the pixels, and a check with numbers.

## Pick the method

| The subject | The rough mask | Then |
|---|---|---|
| On a plain studio backdrop (white, grey, green) | `backdrop` key, or the `studio-cutout` recipe | `refine` with `smartRadius` and `decontaminate` |
| On a busy background | `gen_prepare` `segment` (Select Subject) if an image tool is connected, otherwise a vector outline | `refine` |
| The same scene was shot empty (a clean plate) | `difference` key against the plate | `refine` |
| Trees, branches or sky | `channel` mask on the channel with the most contrast (usually blue), with `black` and `white` | `refine` for the roofline |
| Glass, clear plastic, liquids | the `glass` recipe: a silhouette plus blend modes, not a plain mask | `glass-bend`, `glass-contact` |
| Powder, smoke, sparks, fire on black | the `light-on-dark` recipe: its own brightness | Screen on dark backgrounds |
| Fur against grass or another busy background | `segment`, then `refine` with radius 25–30 and `decontaminate` 100 | `choke` 1–2 for a fringe that's left |

The closer the rough mask, the better the edge: `refine` solves a band around the rough edge, so a loose mask leaves more to guess. On a studio backdrop the `backdrop` key is close already. Mask fields are in the compositing skill: [Refining edges](../compositing/SKILL.md).

## Work in this order

1. **Rough mask.** Use a method from the table.
2. **Solve the edge.**
   - Add `refine` with a `radius` that covers the soft edge: 4–6 px for products, 10–20 for hair, 25–30 for fur.
   - Add `smartRadius: true` when hard and soft edges meet, as with a head of hair over a jacket.
3. **Clean the colour.** Add `decontaminate` 60–100 to remove the old background's colour from the edge.
4. **Choke what's left.** If a thin rim of old background survives (a mask that was cut too wide), add `choke` 1–3 on the mask: Photoshop's Minimum on a mask. Negative values spread it (Maximum), to recover an edge cut too tight.
5. **Check it** (below), on a contrasting background, and adjust.

## The check loop

An edge that looks fine on the new background can show a fringe on another. Check with numbers:

```json
{ "doc": "<doc>", "layers": ["<cut-out>"], "matte": true, "map": "matte" }
```

`canvas_inspect` renders the cut-out alone, and the map shows its mask and the cut-out over black, white and red. Read the report this way:

- **`halo`:** below 10 is clean. Above 20, the old background shows as a fringe. Raise `decontaminate`, then add `choke` 1–2.
  - **`haloTone`** says where the fringe shows: a lighter fringe shows on dark backgrounds, a darker one on light backgrounds.
- **`edgeWidth`:** about 1 px for crisp products, a few px for hair. Much wider than the background's focus looks pasted on, so lower the `radius`.
- **`specks`:** small bits apart from the subject. They're either leftover background (remove them: mask them out with a vector shape, or raise the key `tolerance`) or stray strands (keep them).
- **`holes`:** see-through pockets inside the subject. They're either dropouts, such as a white shirt keyed out with a white backdrop (use `fillHoles`, or lower the `tolerance`), or real gaps, such as between an arm and the body. Look at the map to tell which.

Then render the composite with `compare: { hide: ["<cut-out>"] }`, or against an earlier revision, and zoom into the hardest edges (hair, fur, glass rims, fine branches) at 200–300%.

## Hair and fur

- **One pass is usually enough** with `smartRadius`: the band stays narrow on the shoulders and opens up in the hair. Photoshop users often do two passes, smoothing the body and then refining the hair; Gesso's solve snaps a jagged body edge to the photo by itself.
- **When the body edge still needs smoothing** (`smooth`, `contrast`), which would flatten the hair, split it into two copies of the photo:
  - one in a group whose vector mask covers the hair, with `refine` for hair
  - one in a group with the same mask inverted, with `refine` `{ "radius": 3, "smooth": 20, "contrast": 15 }`
- **Fur against grass** is the hardest case, because the fringe takes on the grass colour. Use `radius` 25–30, `decontaminate` 100 and `choke` 1–2, and check `halo` over a dark grey. Painting new strands into the mask with a brush (Photoshop's grass-brush trick) isn't possible in Gesso yet.

## Glass and clear objects

A plain mask makes glass opaque: the backdrop it was shot on stays inside it. The `glass` recipe rebuilds the object from what each part does instead. It's a group with the object's silhouette as its mask, holding, from the bottom up:

| Layer | What it is | Blend | Its job |
|---|---|---|---|
| Solid | white, masked to `opaque` | normal | makes the cap, label and foil opaque again |
| Shadows | the photo, desaturated, with Levels | multiply | keeps the dark rims and reflections |
| Highlights | the photo, desaturated, with Levels | screen | keeps only the speculars |
| Color | the photo, masked to its coloured parts | color | puts back the liquid's and the cap's colour |

The group is pass-through, so the copies blend with the new background inside the silhouette.

**Steps:**
1. **Measure the backdrop.** `canvas_inspect` `samples` on the backdrop just beside the glass gives its brightness: pass it as `backdrop`.
   - The Shadows Levels set that brightness to white, so clear glass doesn't darken the new background.
   - The Highlights Levels drop everything up to `highlights` above it, so only speculars survive.
2. **Mark the opaque parts.** Pass `opaque` as a mask over the cap and label: a vector `compound` of their outlines, or a `segment` mask. They'd otherwise go see-through.
3. **Apply `glass`.** The silhouette comes from a `backdrop` key with `fillHoles`, so the clear parts the backdrop shows through still count as the object. For a busy-background shot, give the group a `segment` mask instead.
4. **Balance the two Levels together.**
   - Darker rims: lower `shadows` towards 0.6.
   - Fewer, brighter speculars: raise `highlights`.
   - Above 1, `shadows` makes the glass fade away.
   - Adding both blend layers darkens the object overall, so expect to go back and forth between them.
5. **Add refraction** with `glass-bend`: a warped copy of the background at the bottom of the group. Lines seen through the glass then no longer meet the ones beside it. Set `at` to where the glass stands, as a fraction across.
6. **Ground it** with `glass-contact`:
   - a soft cast shadow away from the light (`direction` 1 when the light comes from the left)
   - a caustic in the liquid's colour, Color Dodge, where light passing through it lands
   - Both are masked by the inverted silhouette, so they can't paint over the glass. Read the light direction from the original shot's own shadow.

**Gotchas:**
- Keep the Shadows and Highlights copies desaturated. The Color layer carries the colour, and they would double it.
- The Color layer is masked to the photo's coloured parts (a `saturation` mask), so clear glass doesn't grey out the background behind it.

## Light on dark: powder, smoke, sparks, fire

Shot on black, these are their own masks: brightness is how dense they are. `light-on-dark` sets a `luminosity` mask from the layer's own pixels.
- The layer gets real transparency, so a `drop-shadow` effect follows the particles, not the layer's rectangle.
- With `blend` `screen`, the thin parts also lift dark backgrounds. On light backgrounds keep `normal`, or the thin parts turn grey.
- `level` 2–3 thins out faint haze you don't want.

## Blend If, kept

Blend If (`blendIf`) hides a layer by its tones, which is quick for skies behind trees. But it reads the layer's current pixels, so a tonal adjustment later moves the cut. For a cut that stays put, use a `channel` mask with the same split instead: Blend If on the blue channel with the white point split at 166/200 becomes `{ "kind": "channel", "channel": "blue", "black": 166, "white": 200, "invert": true, "source": "<layer>" }`. It's live, it's a real mask, and it exports to PSD as one.

Pick the channel by sampling the subject and the background (`canvas_inspect` `samples`): use the channel where they differ most. Note which way round it is (a dark subject on a light background needs `invert`).

## Keep an adjustment inside one object

A Hue/Saturation aimed at a blue bag also shifts a blue sky. Two masks together keep it on the bag:
- **The colour:** give the adjustment layer a `color-range` mask, sampled on the object with low `fuzziness` (10–20).
- **The area:** put the adjustment in a group whose vector mask loosely outlines the object.

The group passes through, so the adjustment still works on everything below, but only where both masks allow.

## Masks, the Photoshop way round

| In Photoshop | In Gesso |
|---|---|
| Disable a mask (Shift-click) | compare with it hidden: `canvas_render` `compare` against the revision before the mask |
| See the mask itself (Alt-click) | `canvas_inspect` `map: "matte"` |
| Copy a mask to another layer (Alt-drag) | `canvas_get` it, then `set` the same `mask` on the other layer |
| Copy and invert (Alt+Shift-drag) | the same, with `invert: true` |
| Invert (Ctrl+I) | `invert: true` |
| Minimum / Maximum on the mask | `choke` (positive / negative) with `chokeShape` |
| Mask density | the layer's `opacity` with a duplicate, or lower the key `tolerance` |
| Turn Blend If into a mask | a `channel` mask with the same split |
