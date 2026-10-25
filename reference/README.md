# Gesso against Photoshop

Gesso's own golden tests compare it with itself. This folder compares it with Photoshop, so the differences can be measured and fixed. There are 73 cases:

- 15 adjustment layers
- 25 blend modes
- 9 layer styles
- 24 filters and adjustment commands

Each case is one 512×384 artboard, built on a test chart (`chart.png`) with colour patches, ramps, gradients, skin and sky tones, fine lines and edges.

## 1. Get the kit

```sh
REFERENCE_KIT=1 pnpm vitest run packages/render/test/photoshop.test.ts
```

This writes `reference/kit/`:

- `adjustments.psd`, `blend-modes.psd` and `layer-styles.psd`: Photoshop renders these itself. The adjustment layers, blend modes and layer styles are live.
- `filters.psd` and `filters.md`: the chart on its own in each artboard. You apply each filter in Photoshop.

## 2. In Photoshop

1. **Colour settings.** In **Edit › Color Settings**, set **Working Spaces › RGB** to **sRGB IEC61966-2.1**. When a file opens with a **Missing Profile** warning, choose **Assign working RGB**. Gesso works in sRGB, and so must Photoshop for the numbers to mean anything.
2. **Open the three live files:** `adjustments.psd`, `blend-modes.psd` and `layer-styles.psd`. Change nothing.
3. **Open `filters.psd`.** For each artboard, select its **Chart** layer and apply the filter in `filters.md`, with exactly those settings. Everything not listed stays at its default.
4. **Export every artboard as a PNG**, for each of the four files: **File › Export › Export As…**, select all artboards, format **PNG**, **Convert to sRGB** on, size **100%**, then **Export All**. Photoshop names each file after its artboard, for example `curves.png`.
5. **Hand over the PNGs.** Put them in `reference/photoshop/`, or send them to Claude.

## 3. Compare

```sh
pnpm vitest run packages/render/test/photoshop.test.ts
```

For every case with a Photoshop PNG, this renders Gesso's version and scores the difference, using the colour difference CIE76 ΔE per pixel. Under 2 is hard to see; over 5 is clearly different.

It writes `reference/report/`:
- `README.md`, a table with the worst cases first
- one image per case: Gesso, Photoshop, and their difference magnified 8×

`reference/scores.json` keeps each case's accepted score. A case that gets worse by more than 0.25 fails the test, so fixes don't slip back. After an improvement, record the new scores:

```sh
UPDATE_REFERENCE=1 pnpm vitest run packages/render/test/photoshop.test.ts
```

## Not covered yet

- **Colour Lookup:** it needs a LUT that Photoshop reads from the PSD.
- **Dissolve:** its random pattern can't match.
- **Pattern overlay:** it's written as pixels.
- **Filters with random noise** (Add Noise, Crystallize and others): they can't match pixel for pixel.
- **Text:** fonts differ between machines.
