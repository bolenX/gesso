import type { Adjustment, BlendMode, Doc, Effect, Filter, Layer } from "@gesso/core";

// Cases for measuring Gesso against Photoshop (see reference/README.md). Each case is one artboard.
// Adjustments, blend modes and layer styles stay live in the kit's PSDs, so Photoshop renders them itself.
// Filters are written as plain pixels; the `photoshop` line says which filter and settings to apply.

export const W = 512;
export const H = 384;

export type Group = "adjustments" | "blend-modes" | "layer-styles" | "filters";

export type Case = {
  id: string;
  group: Group;
  layers: Layer[];
  /** For filters: what to apply in Photoshop to the chart layer, with the exact settings. */
  photoshop?: string;
  /** The filter Gesso applies to the chart layer (left out of the kit's PSD). */
  filter?: Filter;
};

const full = { x: 0, y: 0, w: W, h: H };
const chart = (): Layer => ({ id: "chart", name: "Chart", type: "image", asset: "chart", fit: "fill", frame: full }) as Layer;

const adjustments: Array<[string, Adjustment]> = [
  ["brightness-contrast", { kind: "brightness-contrast", brightness: 30, contrast: 40 }],
  ["levels", { kind: "levels", inputBlack: 20, inputWhite: 230, gamma: 0.8 }],
  ["curves", { kind: "curves", points: [[0, 0], [64, 48], [192, 210], [255, 255]] }],
  ["exposure", { kind: "exposure", exposure: 0.7 }],
  ["vibrance", { kind: "vibrance", vibrance: 60, saturation: 10 }],
  ["hue-saturation", { kind: "hue-saturation", hue: 30, saturation: 20, lightness: 0 }],
  ["color-balance", { kind: "color-balance", midtones: [20, -10, -30] }],
  ["black-white", { kind: "black-white" }],
  ["photo-filter", { kind: "photo-filter", color: "#EC8A00", density: 25 }],
  ["channel-mixer", { kind: "channel-mixer", red: [70, 30, 0, 0] }],
  ["invert", { kind: "invert" }],
  ["posterize", { kind: "posterize", levels: 4 }],
  ["threshold", { kind: "threshold", level: 128 }],
  ["gradient-map", { kind: "gradient-map", stops: [{ offset: 0, color: "#1A1033" }, { offset: 0.5, color: "#E8471A" }, { offset: 1, color: "#FFF2C8" }] }],
  ["selective-color", { kind: "selective-color", reds: [-40, 10, 20, 0], neutrals: [0, 0, -10, 0] }],
];

const BLENDS: BlendMode[] = [
  "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion",
  "hue", "saturation", "color", "luminosity", "linear-burn", "darker-color", "linear-dodge", "lighter-color", "vivid-light", "linear-light",
  "pin-light", "hard-mix", "subtract", "divide",
];

const styles: Array<[string, Effect]> = [
  ["drop-shadow", { kind: "drop-shadow", color: "#000000", opacity: 0.75, angle: 120, distance: 12, size: 16, spread: 0 }],
  ["outer-glow", { kind: "outer-glow", color: "#FFF2A0", opacity: 0.9, size: 20, spread: 0.1 }],
  ["stroke", { kind: "stroke", color: "#E8471A", width: 6, position: "outside", opacity: 1 }],
  ["color-overlay", { kind: "color-overlay", color: "#2D9C6A", opacity: 0.6 }],
  ["inner-shadow", { kind: "inner-shadow", color: "#000000", opacity: 0.75, angle: 120, distance: 8, size: 12, choke: 0 }],
  ["inner-glow", { kind: "inner-glow", color: "#FFF2A0", opacity: 0.9, size: 18, choke: 0, source: "edge" }],
  ["bevel", { kind: "bevel", style: "inner-bevel", depth: 100, direction: "up", size: 12, soften: 0, angle: 120, altitude: 30, highlight: "#FFFFFF", highlightOpacity: 0.75, shadow: "#000000", shadowOpacity: 0.75 }],
  ["satin", { kind: "satin", color: "#000000", opacity: 0.5, angle: 19, distance: 11, size: 14 }],
  ["gradient-overlay", { kind: "gradient-overlay", stops: [{ offset: 0, color: "#1A1033" }, { offset: 1, color: "#E8471A" }], angle: 90, style: "linear", opacity: 1 }],
];

const filters: Array<[string, Filter, string]> = [
  ["gaussian-blur", { kind: "gaussian-blur", radius: 4 }, "Filter › Blur › Gaussian Blur: Radius 4.0 pixels"],
  ["box-blur", { kind: "box-blur", radius: 4 }, "Filter › Blur › Box Blur: Radius 4 pixels"],
  ["motion-blur", { kind: "motion-blur", angle: 30, distance: 20 }, "Filter › Blur › Motion Blur: Angle 30°, Distance 20 pixels"],
  ["surface-blur", { kind: "surface-blur", radius: 5, threshold: 15 }, "Filter › Blur › Surface Blur: Radius 5 pixels, Threshold 15 levels"],
  ["median", { kind: "median", radius: 3 }, "Filter › Noise › Median: Radius 3 pixels"],
  ["dust-and-scratches", { kind: "dust-and-scratches", radius: 2, threshold: 10 }, "Filter › Noise › Dust & Scratches: Radius 2 pixels, Threshold 10 levels"],
  ["despeckle", { kind: "despeckle" }, "Filter › Noise › Despeckle"],
  ["unsharp-mask", { kind: "sharpen", amount: 1, radius: 2, threshold: 0 }, "Filter › Sharpen › Unsharp Mask: Amount 100%, Radius 2.0 pixels, Threshold 0 levels"],
  ["high-pass", { kind: "high-pass", radius: 4 }, "Filter › Other › High Pass: Radius 4.0 pixels"],
  ["minimum", { kind: "minimum", radius: 2 }, "Filter › Other › Minimum: Radius 2 pixels, Preserve: Squareness"],
  ["maximum", { kind: "maximum", radius: 2 }, "Filter › Other › Maximum: Radius 2 pixels, Preserve: Squareness"],
  ["offset", { kind: "offset", x: 64, y: 32, edges: "wrap" }, "Filter › Other › Offset: Horizontal +64 pixels right, Vertical +32 pixels down, Wrap Around"],
  ["emboss", { kind: "emboss", angle: 135, height: 3, amount: 100 }, "Filter › Stylize › Emboss: Angle 135°, Height 3 pixels, Amount 100%"],
  ["find-edges", { kind: "find-edges" }, "Filter › Stylize › Find Edges"],
  ["solarize", { kind: "solarize" }, "Filter › Stylize › Solarize"],
  ["mosaic", { kind: "pixelate", size: 8 }, "Filter › Pixelate › Mosaic: Cell Size 8 square"],
  ["twirl", { kind: "twirl", angle: 90 }, "Filter › Distort › Twirl: Angle 90°"],
  ["pinch", { kind: "pinch", amount: 50 }, "Filter › Distort › Pinch: Amount 50%"],
  ["spherize", { kind: "spherize", amount: 50, mode: "normal" }, "Filter › Distort › Spherize: Amount 50%, Mode Normal"],
  ["polar-coordinates", { kind: "polar-coordinates", mode: "rect-to-polar" }, "Filter › Distort › Polar Coordinates: Rectangular to Polar"],
  ["desaturate", { kind: "desaturate" }, "Image › Adjustments › Desaturate"],
  ["equalize", { kind: "equalize" }, "Image › Adjustments › Equalize"],
  ["shadows-highlights", { kind: "shadows-highlights", shadows: 35, highlights: 0, radius: 30 }, "Image › Adjustments › Shadows/Highlights (Show More Options): Shadows Amount 35%, Tone 50%, Radius 30 px; Highlights Amount 0%; Adjustments Color 20, Midtone 0"],
  ["camera-raw", { kind: "camera-raw", exposure: 0.5, contrast: 20, highlights: -30, shadows: 30, vibrance: 20 }, "Filter › Camera Raw Filter, Basic panel: Exposure +0.50, Contrast +20, Highlights −30, Shadows +30, Vibrance +20 (everything else 0)"],
];

export const CASES: Case[] = [
  ...adjustments.map(([id, adjustment]): Case => ({
    id,
    group: "adjustments",
    layers: [chart(), { id: "adjustment", name: id, type: "adjustment", adjustment, frame: full } as Layer],
  })),
  ...BLENDS.map((blend): Case => ({
    id: `blend-${blend}`,
    group: "blend-modes",
    layers: [chart(), { id: "overlay", name: blend, type: "image", asset: "overlay", fit: "fill", frame: full, blend } as Layer],
  })),
  ...styles.map(([id, effect]): Case => ({
    id: `style-${id}`,
    group: "layer-styles",
    layers: [
      { id: "ground", name: "Ground", type: "shape", shape: { kind: "rect" }, fill: "#B4B0A8", frame: full } as Layer,
      { id: "card", name: id, type: "shape", shape: { kind: "rect", radius: 24 }, fill: "#3D7BE0", frame: { x: 136, y: 112, w: 240, h: 160 }, effects: [effect] } as Layer,
    ],
  })),
  ...filters.map(([id, filter, photoshop]): Case => ({ id: `filter-${id}`, group: "filters", layers: [chart()], filter, photoshop })),
];

/** One document per group, an artboard per case, laid out in a grid. With `forPhotoshop`, filters are left for Photoshop to apply. */
export function groupDoc(group: Group, forPhotoshop: boolean): Doc {
  const cases = CASES.filter((c) => c.group === group);
  return {
    id: `reference-${group}`,
    revision: 0,
    assets: {
      chart: { uri: "chart.png", kind: "image", width: W, height: H },
      overlay: { uri: "overlay.png", kind: "image", width: W, height: H },
    },
    artboards: cases.map((c, i) => ({
      id: c.id,
      name: c.id,
      frame: { x: (i % 6) * (W + 64), y: Math.floor(i / 6) * (H + 96), w: W, h: H },
      background: "#FFFFFF",
      layers: c.layers.map((l) => (l.id === "chart" && c.filter && !forPhotoshop ? ({ ...l, filters: [c.filter] } as Layer) : l)),
    })),
  };
}
