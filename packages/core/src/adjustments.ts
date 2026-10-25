import { z } from "zod";
import { Color } from "./primitives.js";

// Adjustment layers: Photoshop's Image › Adjustments that exist as adjustment layers. They
// recolour everything below them (within their frame and mask) and stay live adjustment layers
// in a PSD. Values follow Photoshop's dialogs.

const Stop = z.object({ offset: z.number().min(0).max(1), color: Color });
const CurvePoint = z.tuple([z.number().min(0).max(255), z.number().min(0).max(255)]);
const Curve = z.array(CurvePoint).min(2);
const Percent = z.number().min(-100).max(100);
/** Hue/Saturation for one colour range. */
const HslShift = z.object({ hue: z.number().min(-180).max(180).optional(), saturation: Percent.optional(), lightness: Percent.optional() });
/** Colour Balance for one tonal range: cyan−red, magenta−green, yellow−blue. */
const Balance = z.tuple([Percent, Percent, Percent]);
/** Selective Color for one range: cyan, magenta, yellow, black. */
const Cmyk = z.tuple([Percent, Percent, Percent, Percent]);
/** Channel Mixer output: red, green and blue source percentages (−200..200) and a constant (−200..200). */
const Mix = z.tuple([z.number().min(-200).max(200), z.number().min(-200).max(200), z.number().min(-200).max(200), z.number().min(-200).max(200)]);
const Weight = z.number().min(-200).max(300);
const RANGES = ["reds", "yellows", "greens", "cyans", "blues", "magentas"] as const;

export const Adjustment = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("brightness-contrast"),
    brightness: z.number().min(-150).max(150),
    contrast: z.number().min(-50).max(100),
  }),
  z.object({
    kind: z.literal("hue-saturation"),
    hue: z.number().min(-180).max(180),
    saturation: Percent,
    lightness: Percent,
    /** Edits limited to one colour range (Photoshop's Reds…Magentas menu), on top of the master values. */
    ranges: z.object(Object.fromEntries(RANGES.map((r) => [r, HslShift.optional()])) as Record<(typeof RANGES)[number], z.ZodOptional<typeof HslShift>>).optional(),
  }),
  z.object({
    kind: z.literal("curves"),
    /** The channel `points` shape; "rgb" (all three) by default. */
    channel: z.enum(["rgb", "red", "green", "blue"]).optional(),
    points: Curve,
    /** Extra per-channel curves, applied after `points`. */
    red: Curve.optional(),
    green: Curve.optional(),
    blue: Curve.optional(),
  }),
  z.object({
    /** Recolours by brightness: dark pixels take the first stop's colour, light ones the last. */
    kind: z.literal("gradient-map"),
    stops: z.array(Stop).min(2),
    reverse: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("levels"),
    channel: z.enum(["rgb", "red", "green", "blue"]).optional(),
    inputBlack: z.number().min(0).max(255),
    inputWhite: z.number().min(0).max(255),
    gamma: z.number().positive(),
    outputBlack: z.number().min(0).max(255).optional(),
    outputWhite: z.number().min(0).max(255).optional(),
  }),
  z.object({
    /** Exposure in stops, offset (−0.5..0.5) and gamma, in linear light like Photoshop. */
    kind: z.literal("exposure"),
    exposure: z.number().min(-20).max(20),
    offset: z.number().min(-0.5).max(0.5).optional(),
    gamma: z.number().min(0.01).max(9.99).optional(),
  }),
  z.object({
    /** Vibrance boosts muted colours more than saturated ones (and spares skin); saturation is even. */
    kind: z.literal("vibrance"),
    vibrance: Percent,
    saturation: Percent.optional(),
  }),
  z.object({
    kind: z.literal("color-balance"),
    shadows: Balance.optional(),
    midtones: Balance.optional(),
    highlights: Balance.optional(),
    /** Keep each pixel's brightness (Photoshop's default). */
    preserveLuminosity: z.boolean().optional(),
  }),
  z.object({
    /** Black & White: how bright each colour range turns, in % (Photoshop's defaults when left out), with an optional tint. */
    kind: z.literal("black-white"),
    reds: Weight.optional(),
    yellows: Weight.optional(),
    greens: Weight.optional(),
    cyans: Weight.optional(),
    blues: Weight.optional(),
    magentas: Weight.optional(),
    tint: Color.optional(),
  }),
  z.object({
    /** Photo Filter: a coloured lens filter at `density` %. */
    kind: z.literal("photo-filter"),
    color: Color,
    density: z.number().min(0).max(100),
    preserveLuminosity: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal("channel-mixer"),
    red: Mix.optional(),
    green: Mix.optional(),
    blue: Mix.optional(),
    /** Monochrome: one grey output mixed from the channels. */
    monochrome: Mix.optional(),
  }),
  z.object({
    /** Color Lookup: a 3D LUT (a .cube file, imported as an asset of kind "lut"). */
    kind: z.literal("color-lookup"),
    lut: z.string(),
  }),
  z.object({ kind: z.literal("invert") }),
  z.object({ kind: z.literal("posterize"), levels: z.number().int().min(2).max(255) }),
  z.object({ kind: z.literal("threshold"), level: z.number().int().min(1).max(255) }),
  z.object({
    /** Selective Color: CMYK shifts per colour range, relative (Photoshop's default) or absolute. */
    kind: z.literal("selective-color"),
    mode: z.enum(["relative", "absolute"]).optional(),
    ...(Object.fromEntries([...RANGES, "whites", "neutrals", "blacks"].map((r) => [r, Cmyk.optional()])) as Record<(typeof RANGES)[number] | "whites" | "neutrals" | "blacks", z.ZodOptional<typeof Cmyk>>),
  }),
]);
export type Adjustment = z.infer<typeof Adjustment>;

/** Assets an adjustment reads (LUT files). */
export function adjustmentAssets(adjustment: Adjustment): string[] {
  return adjustment.kind === "color-lookup" ? [adjustment.lut] : [];
}
