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

export { BlendMode, Color } from "./primitives.js";
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

export const Shape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rect"), radius: z.number().nonnegative().optional() }),
  z.object({ kind: z.literal("ellipse") }),
  z.object({ kind: z.literal("path"), d: z.string() }),
]);
export type Shape = z.infer<typeof Shape>;

export const Mask = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("raster"),
    asset: z.string(),
    invert: z.boolean().optional(),
    feather: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal("vector"),
    shape: Shape,
    feather: z.number().nonnegative().optional(),
    /** Where the shape sits within the layer's box; the whole box when left out. */
    frame: Frame.optional(),
    /** Hide inside the shape instead of outside it. */
    invert: z.boolean().optional(),
  }),
  z.object({ kind: z.literal("luminance-of"), layer: Id }),
]);
export type Mask = z.infer<typeof Mask>;

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

const LayerBase = z.object({
  id: Id,
  name: z.string(),
  meta: Meta.optional(),
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  /** Fades the layer's own pixels but not its effects, like Photoshop's Fill and Figma's fill opacity. */
  fillOpacity: z.number().min(0).max(1).optional(),
  blend: BlendMode.optional(),
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
});

export const ImageLayer = LayerBase.extend({
  type: z.literal("image"),
  asset: z.string(),
  fit: z.enum(["cover", "contain", "fill"]).optional(),
  /** Focus point for crops, 0..1 in each axis. */
  focus: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]).optional(),
});

export const Stroke = z.object({ paint: Paint, width: z.number().nonnegative() });

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

const CurvePoint = z.tuple([z.number().min(0).max(255), z.number().min(0).max(255)]);

export const Adjustment = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("brightness-contrast"),
    brightness: z.number().min(-150).max(150),
    contrast: z.number().min(-50).max(100),
  }),
  z.object({
    kind: z.literal("hue-saturation"),
    hue: z.number().min(-180).max(180),
    saturation: z.number().min(-100).max(100),
    lightness: z.number().min(-100).max(100),
  }),
  z.object({
    kind: z.literal("curves"),
    channel: z.enum(["rgb", "red", "green", "blue"]).optional(),
    points: z.array(CurvePoint).min(2),
  }),
  z.object({
    /** Recolours by brightness: dark pixels take the first stop's colour, light ones the last. */
    kind: z.literal("gradient-map"),
    stops: z.array(GradientStop).min(2),
    reverse: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("levels"),
    inputBlack: z.number().min(0).max(255),
    inputWhite: z.number().min(0).max(255),
    gamma: z.number().positive(),
    outputBlack: z.number().min(0).max(255).optional(),
    outputWhite: z.number().min(0).max(255).optional(),
  }),
]);

export const AdjustmentLayer = LayerBase.extend({
  type: z.literal("adjustment"),
  adjustment: Adjustment,
});

const Point = z.tuple([z.number(), z.number()]);

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
  kind: z.enum(["image", "font", "mask"]),
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
