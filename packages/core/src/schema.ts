import { z } from "zod";

// Document IR, v0.1. See docs/spec-v0.1.md, "Document schema".
// Layer arrays run bottom to top, matching PSD.

/** Stable, meaningful IDs: "headline", not "layer_17". */
export const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/i, "IDs are letters, digits and dashes, e.g. \"card-photo\"");

export const Role = z.enum([
  "background",
  "subject",
  "product",
  "container",
  "logo",
  "headline",
  "body",
  "cta",
  "decoration",
  "overlay",
  "grade",
  "generated-extension",
]);
export type Role = z.infer<typeof Role>;

export { BlendMode, Color, isStandardBlend, STANDARD_BLENDS } from "./primitives.js";
import { BlendMode, Color } from "./primitives.js";

export const GradientStop = z.object({ offset: z.number().min(0).max(1), color: Color });

/**
 * A mesh gradient, like Illustrator's gradient mesh: a grid of colour points over the shape's
 * box, blended smoothly between neighbours. Move points (fractions of the box, 0..1) to bend
 * the colour flow; colours pass exactly through every point.
 */
export const MeshGradient = z
  .object({
    kind: z.literal("mesh-gradient"),
    /** Point colours, row by row from the top, each row left to right; at least 2×2. */
    colors: z.array(z.array(Color).min(2)).min(2),
    /** Point positions with the same shape as colors, as [x, y] fractions of the box. Defaults to an even grid. */
    points: z.array(z.array(z.tuple([z.number(), z.number()]))).optional(),
  })
  .superRefine((mesh, ctx) => {
    const cols = mesh.colors[0]!.length;
    if (mesh.colors.some((row) => row.length !== cols)) ctx.addIssue({ code: "custom", message: "every row of colors needs the same number of points", path: ["colors"] });
    if (mesh.points && (mesh.points.length !== mesh.colors.length || mesh.points.some((row) => row.length !== cols))) {
      ctx.addIssue({ code: "custom", message: `points needs the same shape as colors (${mesh.colors.length} rows of ${cols})`, path: ["points"] });
    }
  });

export const Paint = z.union([
  Color,
  z.object({
    kind: z.literal("linear-gradient"),
    angle: z.number(),
    stops: z.array(GradientStop).min(2),
  }),
  z.object({
    kind: z.literal("radial-gradient"),
    stops: z.array(GradientStop).min(2),
  }),
  MeshGradient,
]);
export type Paint = z.infer<typeof Paint>;

/** A representative flat colour for a paint, where only one colour fits (text in PSD, fallbacks). */
export function paintColor(paint: Paint): string {
  if (typeof paint === "string") return paint;
  return paint.kind === "mesh-gradient" ? paint.colors[0]![0]! : paint.stops[0]!.color;
}

export const Provenance = z.object({
  op: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  seed: z.number().int().optional(),
  sourceRevision: z.number().int().nonnegative().optional(),
});

export const Meta = z.object({
  role: Role.optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  locked: z.boolean().optional(),
  provenance: Provenance.optional(),
});
export type Meta = z.infer<typeof Meta>;

export const Anchor = z.enum([
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
]);
export type Anchor = z.infer<typeof Anchor>;

/** A length in pixels, or a percentage of the artboard, e.g. "40%". */
export const Len = z.union([z.number().nonnegative(), z.string().regex(/^\d+(\.\d+)?%$/)]);

export const Box = z.object({ x: z.number(), y: z.number(), w: z.number().nonnegative(), h: z.number().nonnegative() });

/** Absolute box, or intent-based layout so reflow across sizes works. */
export const Frame = z.union([
  Box,
  z.object({
    anchor: Anchor,
    margin: z.union([z.number(), z.tuple([z.number(), z.number()])]).optional(),
    w: Len.optional(),
    h: Len.optional(),
    aspect: z.number().positive().optional(),
  }),
]);
export type Frame = z.infer<typeof Frame>;

const BasicShape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rect"), radius: z.number().nonnegative().optional() }),
  z.object({ kind: z.literal("ellipse") }),
  z.object({ kind: z.literal("path"), d: z.string() }),
]);
export const Shape = z.discriminatedUnion("kind", [
  ...BasicShape.options,
  /**
   * Shapes combined like Photoshop's path operations (Pathfinder in Illustrator): each part sits
   * in its own frame within the box and is added to, subtracted from, intersected with, or
   * excluded from (XOR) the parts before it.
   */
  z.object({
    kind: z.literal("compound"),
    parts: z
      .array(z.object({ shape: BasicShape, frame: Frame.optional(), op: z.enum(["add", "subtract", "intersect", "exclude"]).optional() }))
      .min(1)
      .max(64),
  }),
]);
export type Shape = z.infer<typeof Shape>;

/**
 * Select and Mask / Refine Edge: snaps a mask's soft edge to the detail in the layer's own pixels (hair, fur,
 * foliage), estimating each edge pixel's coverage from the nearby subject and background colours, then shapes it. Decontaminating replaces the old background's colour in
 * the semi-transparent edge with the subject's own nearby colours.
 */
export const Refine = z.object({
  /** How far from the edge to look for detail, in px (Photoshop's edge radius): 2–6 for hard edges, 10–30 for hair. */
  radius: z.number().positive().max(250).optional(),
  /**
   * Smart Radius: keep the full radius only where the edge has fine detail (hair, fur), and a narrow band along
   * clean edges, so one setting suits a subject with both.
   */
  smartRadius: z.boolean().optional(),
  /** Smooths jagged edges before refining, 0..100. */
  smooth: z.number().min(0).max(100).optional(),
  /** Hardens the soft edge, 0..100. */
  contrast: z.number().min(0).max(100).optional(),
  /** Moves the edge in (negative) or out (positive), −100..100. */
  shift: z.number().min(-100).max(100).optional(),
  /** Decontaminate Colors: how much of the old background's colour to remove from the edge, 0..100. */
  decontaminate: z.number().min(0).max(100).optional(),
});
export type Refine = z.infer<typeof Refine>;

/**
 * Filter › Other › Minimum and Maximum on a mask, applied last: `choke` in px pulls the edge in (positive, to
 * lose a halo of old background) or pushes it out (negative, to recover an edge cut too tight, or for a sticker
 * outline). Round corners suit people and organic shapes, square ones man-made, straight-edged objects.
 */
const Choke = {
  choke: z.number().min(-250).max(250).optional(),
  chokeShape: z.enum(["round", "square"]).optional(),
};

/** One channel of a layer (or of everything below) for Calculations; gray is luminosity. */
const CalcChannel = z.object({ source: z.string().optional(), channel: z.enum(["red", "green", "blue", "gray"]), invert: z.boolean().optional() });

export const Mask = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("raster"),
    asset: z.string(),
    /**
     * An image layer whose pixels the mask was made from (a selection like Select Subject or Select Sky): the
     * mask then follows that layer's frame, fit, focus, rotation, flips, skew, distortion and warp, on any layer.
     * Without it, the mask stretches over this layer's own box.
     */
    of: Id.optional(),
    invert: z.boolean().optional(),
    feather: z.number().nonnegative().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({
    kind: z.literal("vector"),
    shape: Shape,
    feather: z.number().nonnegative().optional(),
    /** Where the shape sits within the layer's box; the whole box when left out. */
    frame: Frame.optional(),
    /** Hide inside the shape instead of outside it. */
    invert: z.boolean().optional(),
    /** With a width, the mask is the shape's outline stroked this wide (round caps): a brush stroke along a path. */
    stroke: z.number().positive().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({ kind: z.literal("luminance-of"), layer: Id }),
  /**
   * Computed masks (Photoshop selections kept live): they read a source's pixels, either "below"
   * (everything under this layer, the default) or a layer id, and recompute on every render.
   * In a PSD they're written as pixel masks.
   */
  z.object({
    /** Luminosity mask: lights, darks or midtones (level 1..5 narrows them, like Lights 2, Lights 3), or a [low, high] band in levels. */
    kind: z.literal("luminosity"),
    source: z.string().optional(),
    range: z.union([z.enum(["lights", "darks", "midtones"]), z.tuple([z.number().min(0).max(255), z.number().min(0).max(255)])]),
    level: z.number().int().min(1).max(5).optional(),
    /** Soft edge of a band, in levels. */
    softness: z.number().min(0).max(255).optional(),
    feather: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({
    /** Color Range: where colours are within `fuzziness` (colour distance) of `color`. */
    kind: z.literal("color-range"),
    source: z.string().optional(),
    color: Color,
    fuzziness: z.number().min(0).max(200),
    feather: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({
    /** A colour channel as a mask, with levels (`black`, `white`) to push it to black and white: the channel-mask technique for hair, trees and skies. */
    kind: z.literal("channel"),
    source: z.string().optional(),
    channel: z.enum(["red", "green", "blue"]),
    black: z.number().min(0).max(255).optional(),
    white: z.number().min(0).max(255).optional(),
    feather: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({
    /**
     * Saturation mask: how colourful each pixel is (HSB saturation), with levels (`black`, `white`) to push it.
     * For effects that should touch only coloured parts, or only neutral ones (inverted): a glass's tint but not
     * the clear glass, skin but not grey hair.
     */
    kind: z.literal("saturation"),
    source: z.string().optional(),
    black: z.number().min(0).max(255).optional(),
    white: z.number().min(0).max(255).optional(),
    feather: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({
    /**
     * Calculations (Image › Calculations): two channels blended into a mask, then levels: blue with itself in
     * multiply for a deep sky selection, or red against blue in subtract to separate skin from background.
     */
    kind: z.literal("calculations"),
    a: CalcChannel,
    b: CalcChannel,
    blend: z.enum(["multiply", "screen", "overlay", "soft-light", "hard-light", "add", "subtract", "difference", "darken", "lighten"]),
    /** Opacity of the blend over channel a, 0..1. */
    opacity: z.number().min(0).max(1).optional(),
    black: z.number().min(0).max(255).optional(),
    white: z.number().min(0).max(255).optional(),
    feather: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({
    /**
     * Studio backdrop key: the subject cut out of a plain backdrop (white, grey, green or any colour). The
     * backdrop's colour is read from the image's border, lighting falloff included, or given as `color`; pixels
     * within `tolerance` of it (colour difference, ΔE, default 10) are backdrop, and opacity rises to full at
     * three times that. Reads the layer's own pixels, or `source`'s. Add refine with a radius for hair.
     */
    kind: z.literal("backdrop"),
    source: z.string().optional(),
    color: Color.optional(),
    tolerance: z.number().min(1).max(100).optional(),
    /**
     * Fill see-through pockets inside the subject: for glass and other clear objects, which the backdrop shows
     * through, and for pale parts keyed out along with a backdrop that matches them.
     */
    fillHoles: z.boolean().optional(),
    feather: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
  z.object({
    /**
     * Clean-plate key: whatever differs from the same scene shot without the subject. `plate` is that shot as an
     * image layer (usually hidden, lined up with canvas_align); pixels within `tolerance` of it (ΔE, default 8)
     * are background. Reads the layer's own pixels, or `source`'s. Add refine with a radius for hair.
     */
    kind: z.literal("difference"),
    plate: Id,
    source: z.string().optional(),
    tolerance: z.number().min(1).max(100).optional(),
    /**
     * Fill see-through pockets inside the subject: for glass and other clear objects, which the backdrop shows
     * through, and for pale parts keyed out along with a backdrop that matches them.
     */
    fillHoles: z.boolean().optional(),
    feather: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    refine: Refine.optional(),
    ...Choke,
  }),
]);
export type Mask = z.infer<typeof Mask>;

/** Masks computed from pixels (luminosity, colour range, channel, saturation, calculations, backdrop and clean-plate keys). */
export const isComputedMask = (mask: Mask | undefined): mask is Extract<Mask, { kind: "luminosity" | "color-range" | "channel" | "saturation" | "calculations" | "backdrop" | "difference" }> =>
  mask?.kind === "luminosity" || mask?.kind === "color-range" || mask?.kind === "channel" || mask?.kind === "saturation" || mask?.kind === "calculations" || mask?.kind === "backdrop" || mask?.kind === "difference";

/** Keys that read a layer's own pixels unless given a source. */
export const isKeyMask = (mask: Mask | undefined): mask is Extract<Mask, { kind: "backdrop" | "difference" }> => mask?.kind === "backdrop" || mask?.kind === "difference";

const Range = z.tuple([z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255), z.number().min(0).max(255)]);
/**
 * Layer Style › Blend If: hides the layer where its own brightness ("this") or what's beneath it
 * ("underlying") falls outside a range. A range is [black, black split, white split, white] in
 * levels: fully shown between the splits, fading to hidden at black and white (split equal to its
 * end for a hard cut). Photoshop's default is [0, 0, 255, 255].
 */
export const BlendIf = z.object({
  channel: z.enum(["gray", "red", "green", "blue"]).optional(),
  this: Range.optional(),
  underlying: Range.optional(),
});
export type BlendIf = z.infer<typeof BlendIf>;

export { Filter, filterAssets, type FilterKind } from "./filters.js";
import { Filter } from "./filters.js";

/**
 * Layer effects, as in Photoshop's Layer Style. They follow the layer's content and mask,
 * and export as live effects. Distances and sizes are in pixels.
 */
export const Effect = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("drop-shadow"),
    color: Color.optional(),
    opacity: z.number().min(0).max(1).optional(),
    /** Direction the light comes from, in degrees: 90 is from above, so the shadow falls below. */
    angle: z.number().optional(),
    distance: z.number().nonnegative().optional(),
    size: z.number().nonnegative().optional(),
    /** 0..1: how much of the size is solid before it fades. */
    spread: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal("outer-glow"),
    color: Color.optional(),
    opacity: z.number().min(0).max(1).optional(),
    size: z.number().nonnegative().optional(),
    spread: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal("stroke"),
    color: Color,
    width: z.number().positive(),
    position: z.enum(["outside", "inside", "center"]).optional(),
    opacity: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal("color-overlay"),
    color: Color,
    opacity: z.number().min(0).max(1).optional(),
    blend: BlendMode.optional(),
  }),
  z.object({
    /** A shadow inside the layer's edges, as if it were cut into the surface (multiply by default). */
    kind: z.literal("inner-shadow"),
    color: Color.optional(),
    opacity: z.number().min(0).max(1).optional(),
    angle: z.number().optional(),
    distance: z.number().nonnegative().optional(),
    size: z.number().nonnegative().optional(),
    /** 0..1: how much of the size is solid before it fades. */
    choke: z.number().min(0).max(1).optional(),
    blend: BlendMode.optional(),
  }),
  z.object({
    /** A glow inside the layer, from its edges or its centre (screen by default). */
    kind: z.literal("inner-glow"),
    color: Color.optional(),
    opacity: z.number().min(0).max(1).optional(),
    size: z.number().nonnegative().optional(),
    choke: z.number().min(0).max(1).optional(),
    source: z.enum(["edge", "center"]).optional(),
    blend: BlendMode.optional(),
  }),
  z.object({
    /** Bevel & Emboss: lights and shades the layer's edges as if raised (or sunk) from the surface. */
    kind: z.literal("bevel"),
    style: z.enum(["inner-bevel", "outer-bevel", "emboss", "pillow-emboss"]).optional(),
    /** Steepness in %, 1..1000 (100 by default). */
    depth: z.number().min(1).max(1000).optional(),
    direction: z.enum(["up", "down"]).optional(),
    size: z.number().nonnegative().optional(),
    soften: z.number().nonnegative().optional(),
    /** Light direction in degrees (120: from the upper left) and height above the surface (30). */
    angle: z.number().optional(),
    altitude: z.number().min(0).max(90).optional(),
    highlight: Color.optional(),
    highlightOpacity: z.number().min(0).max(1).optional(),
    shadow: Color.optional(),
    shadowOpacity: z.number().min(0).max(1).optional(),
  }),
  z.object({
    /** Satin: soft interior shading from the layer's own shape, offset and blurred (multiply by default). */
    kind: z.literal("satin"),
    color: Color.optional(),
    opacity: z.number().min(0).max(1).optional(),
    angle: z.number().optional(),
    distance: z.number().nonnegative().optional(),
    size: z.number().nonnegative().optional(),
    invert: z.boolean().optional(),
    blend: BlendMode.optional(),
  }),
  z.object({
    /** A gradient over the layer's pixels, aligned to its box. */
    kind: z.literal("gradient-overlay"),
    stops: z.array(GradientStop).min(2),
    angle: z.number().optional(),
    style: z.enum(["linear", "radial", "reflected"]).optional(),
    /** Size of the gradient relative to the box, in % (10..150). */
    scale: z.number().min(10).max(150).optional(),
    reverse: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    blend: BlendMode.optional(),
  }),
  z.object({
    /** A repeating image (asset) over the layer's pixels, anchored to the artboard. In a PSD it's a clipped pixel layer. */
    kind: z.literal("pattern-overlay"),
    asset: z.string(),
    /** % of the image's size (100 by default). */
    scale: z.number().min(1).max(1000).optional(),
    opacity: z.number().min(0).max(1).optional(),
    blend: BlendMode.optional(),
  }),
  /**
   * Frosted glass: blurs whatever is beneath the layer, inside the layer's shape, like Figma's
   * background blur. The blur only sees what lies within the layer's bounds, so side-by-side
   * strips each smear their own column: the fluted / fractal glass look. Radius is the blur's
   * standard deviation in pixels (Figma's "blur 180" is about radius 90).
   */
  z.object({
    kind: z.literal("background-blur"),
    radius: z.number().positive(),
  }),
]);
export type Effect = z.infer<typeof Effect>;

const Point = z.tuple([z.number(), z.number()]);

const LayerBase = z.object({
  id: Id,
  name: z.string(),
  meta: Meta.optional(),
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  /** Fades the layer's own pixels but not its effects, like Photoshop's Fill and Figma's fill opacity. */
  fillOpacity: z.number().min(0).max(1).optional(),
  blend: BlendMode.optional(),
  blendIf: BlendIf.optional(),
  /** Clips to the nearest non-clipped layer below. */
  clip: z.boolean().optional(),
  mask: Mask.optional(),
  filters: z.array(Filter).optional(),
  effects: z.array(Effect).optional(),
  frame: Frame,
  /** Degrees clockwise, around the centre of the layer's box. Masks stay in place. */
  rotation: z.number().optional(),
  /** Mirrors the layer around the centre of its box, before rotation. */
  flip: z.enum(["horizontal", "vertical", "both"]).optional(),
  /** Slants the layer, in degrees: [horizontal, vertical] (Edit › Transform › Skew), after flipping and before rotating. */
  skew: z.tuple([z.number().min(-89).max(89), z.number().min(-89).max(89)]).optional(),
  /**
   * Distort / Perspective: pins the box's corners (top-left, top-right, bottom-right, bottom-left)
   * at these [x, y] points in the parent's coordinates. Overrides rotation, flip and skew.
   */
  quad: z.tuple([Point, Point, Point, Point]).optional(),
  /**
   * Warp (Edit › Transform › Warp): a grid of points, rows top to bottom, each [x, y] as fractions
   * of the box, that the layer bends through smoothly. An undistorted 3×3 grid is
   * [[[0,0],[0.5,0],[1,0]],[[0,0.5],[0.5,0.5],[1,0.5]],[[0,1],[0.5,1],[1,1]]].
   */
  warp: z.array(z.array(Point).min(2).max(16)).min(2).max(16).optional(),
});

export const ImageLayer = LayerBase.extend({
  type: z.literal("image"),
  asset: z.string(),
  /** cover crops, contain letterboxes, fill stretches, content-aware removes the least noticeable seams to fit (Content-Aware Scale). */
  fit: z.enum(["cover", "contain", "fill", "content-aware"]).optional(),
  /** Focus point for crops, 0..1 in each axis. */
  focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});

export const Stroke = z.object({
  paint: Paint,
  width: z.number().nonnegative(),
  /** Line ends on open paths: butt (default), round (a brush) or square. */
  cap: z.enum(["butt", "round", "square"]).optional(),
  /** Corners: miter (default), round or bevel. */
  join: z.enum(["miter", "round", "bevel"]).optional(),
});

export const ShapeLayer = LayerBase.extend({
  type: z.literal("shape"),
  shape: Shape,
  fill: Paint.optional(),
  stroke: Stroke.optional(),
});

export const TextStyle = z.object({
  font: z.string(),
  size: z.number().positive(),
  weight: z.number().int().min(100).max(900).optional(),
  tracking: z.number().optional(),
  leading: z.number().optional(),
  fill: Paint.optional(),
  align: z.enum(["start", "center", "end", "justify"]).optional(),
});

/** A stretch of text with its own styling; anything left out comes from the layer's style. */
export const TextRun = z.object({
  text: z.string(),
  font: z.string().optional(),
  size: z.number().positive().optional(),
  weight: z.number().int().min(100).max(900).optional(),
  fill: Color.optional(),
  tracking: z.number().optional(),
});

export const TextLayer = LayerBase.extend({
  type: z.literal("text"),
  content: z.string(),
  style: TextStyle,
  /**
   * Text on a path: the baseline follows this SVG path (coordinates relative to the frame's
   * top-left), starting `offset` px along it; style.align places the text along the path.
   */
  path: z.object({ d: z.string(), offset: z.number().optional() }).optional(),
  /** Mixed styling: the runs' texts, joined, must equal content. */
  runs: z.array(TextRun).min(1).optional(),
  box: z
    .union([
      z.object({ kind: z.literal("point") }),
      z.object({ kind: z.literal("area"), shrinkToFit: z.boolean().optional(), minSize: z.number().positive().optional() }),
    ])
    .optional(),
  direction: z.enum(["ltr", "rtl"]).optional(),
});

export { Adjustment, adjustmentAssets } from "./adjustments.js";
import { Adjustment } from "./adjustments.js";

export const AdjustmentLayer = LayerBase.extend({
  type: z.literal("adjustment"),
  adjustment: Adjustment,
});


/**
 * A placed smart object: an instance of a document-level symbol. With a quad it is
 * corner-pinned in perspective (top-left, top-right, bottom-right, bottom-left, in
 * parent coordinates), which is how device mockups hold their screen designs.
 */
export const SmartLayer = LayerBase.extend({
  type: z.literal("smart"),
  symbol: Id,
  quad: z.tuple([Point, Point, Point, Point]).optional(),
});

export type ImageLayer = z.infer<typeof ImageLayer>;
export type SmartLayer = z.infer<typeof SmartLayer>;
export type ShapeLayer = z.infer<typeof ShapeLayer>;
export type TextLayer = z.infer<typeof TextLayer>;
export type AdjustmentLayer = z.infer<typeof AdjustmentLayer>;
export type GroupLayer = z.infer<typeof LayerBase> & {
  type: "group";
  isolation?: "pass-through" | "isolate";
  children: Layer[];
};
export type Layer = ImageLayer | ShapeLayer | TextLayer | AdjustmentLayer | GroupLayer | SmartLayer;

export const GroupLayer: z.ZodType<GroupLayer> = LayerBase.extend({
  type: z.literal("group"),
  isolation: z.enum(["pass-through", "isolate"]).optional(),
  children: z.lazy(() => z.array(Layer)),
});

export const Layer: z.ZodType<Layer> = z.lazy(() =>
  z.union([ImageLayer, ShapeLayer, TextLayer, AdjustmentLayer, GroupLayer, SmartLayer]),
);

export const Asset = z.object({
  uri: z.string(),
  /** image, font, mask (greyscale), or lut (a .cube colour lookup table). */
  kind: z.enum(["image", "font", "mask", "lut"]),
  hash: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Font family name a font asset registers, e.g. "Inter". */
  family: z.string().optional(),
  /** PostScript name Photoshop uses to find the font, e.g. "Inter-Bold". */
  postscriptName: z.string().optional(),
  /** Which face to use from a .ttc/.otc font collection; 0 when left out. */
  face: z.number().int().nonnegative().optional(),
  description: z.string().optional(),
});
export type Asset = z.infer<typeof Asset>;

/** Unknown PSD data, preserved byte for byte and written back untouched. */
export const OpaqueBlock = z.object({
  key: z.string(),
  data: z.string(), // base64
  attachedTo: Id.optional(),
});

export const Artboard = z.object({
  id: Id,
  name: z.string(),
  frame: Box,
  preset: z.string().optional(),
  background: Paint.optional(),
  meta: Meta.optional(),
  layers: z.array(Layer),
});
export type Artboard = z.infer<typeof Artboard>;

export const SmartObject = z.object({
  id: Id,
  name: z.string(),
  size: z.tuple([z.number().positive(), z.number().positive()]),
  background: Paint.optional(),
  layers: z.array(Layer),
});
export type SmartObject = z.infer<typeof SmartObject>;

export const Doc = z.object({
  id: Id,
  revision: z.number().int().nonnegative(),
  assets: z.record(Asset),
  /** Linked across artboards. */
  symbols: z.record(SmartObject).optional(),
  artboards: z.array(Artboard),
  unknown: z.array(OpaqueBlock).optional(),
});
export type Doc = z.infer<typeof Doc>;
