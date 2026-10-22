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

/** The 16 standard W3C/PDF blend modes Skia provides. Photoshop-only modes arrive in v0.2. */
export const BlendMode = z.enum([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);
export type BlendMode = z.infer<typeof BlendMode>;

export const Color = z.string().regex(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i, "Colours are #RRGGBB or #RRGGBBAA");

export const GradientStop = z.object({ offset: z.number().min(0).max(1), color: Color });

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
]);
export type Paint = z.infer<typeof Paint>;

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
  z.object({ kind: z.literal("vector"), shape: Shape, feather: z.number().nonnegative().optional() }),
  z.object({ kind: z.literal("luminance-of"), layer: Id }),
]);
export type Mask = z.infer<typeof Mask>;

/** Smart filters run in order, before mask and blend. More filter kinds arrive in v0.2. */
export const Filter = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("gaussian-blur"), radius: z.number().nonnegative() }),
]);
export type Filter = z.infer<typeof Filter>;

const LayerBase = z.object({
  id: Id,
  name: z.string(),
  meta: Meta.optional(),
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  blend: BlendMode.optional(),
  /** Clips to the nearest non-clipped layer below. */
  clip: z.boolean().optional(),
  mask: Mask.optional(),
  filters: z.array(Filter).optional(),
  frame: Frame,
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

export const TextLayer = LayerBase.extend({
  type: z.literal("text"),
  content: z.string(),
  style: TextStyle,
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

export type ImageLayer = z.infer<typeof ImageLayer>;
export type ShapeLayer = z.infer<typeof ShapeLayer>;
export type TextLayer = z.infer<typeof TextLayer>;
export type AdjustmentLayer = z.infer<typeof AdjustmentLayer>;
export type GroupLayer = z.infer<typeof LayerBase> & {
  type: "group";
  isolation?: "pass-through" | "isolate";
  children: Layer[];
};
export type Layer = ImageLayer | ShapeLayer | TextLayer | AdjustmentLayer | GroupLayer;

export const GroupLayer: z.ZodType<GroupLayer> = LayerBase.extend({
  type: z.literal("group"),
  isolation: z.enum(["pass-through", "isolate"]).optional(),
  children: z.lazy(() => z.array(Layer)),
});

export const Layer: z.ZodType<Layer> = z.lazy(() =>
  z.union([ImageLayer, ShapeLayer, TextLayer, AdjustmentLayer, GroupLayer]),
);

export const Asset = z.object({
  uri: z.string(),
  kind: z.enum(["image", "font", "mask"]),
  hash: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** Font family name a font asset registers, e.g. "Inter". */
  family: z.string().optional(),
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
  layers: z.array(Layer),
});

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
