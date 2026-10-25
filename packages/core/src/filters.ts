import { z } from "zod";
import { BlendMode, Color } from "./primitives.js";

// Smart filters: Photoshop's Filter menu as data. They run in order on a layer's own pixels,
// before its mask, opacity and blend, and stay editable. Every filter takes "opacity" and
// "blend" (Photoshop's Edit › Fade), which mix the result back over the layer's unfiltered
// pixels. Positions ("center", "at", points) are [x, y] fractions of the layer's box; sizes
// are pixels unless noted.

const Point = z.tuple([z.number(), z.number()]);
const Fade = { opacity: z.number().min(0).max(1).optional(), blend: BlendMode.optional() };
const f = <K extends string, T extends z.ZodRawShape>(kind: K, shape: T) => z.object({ kind: z.literal(kind), ...shape, ...Fade });

export const Filter = z.discriminatedUnion("kind", [
  // ── Blur ──────────────────────────────────────────────────────────────────────────────
  f("gaussian-blur", { radius: z.number().nonnegative() }),
  /** Filter › Blur › Average: the layer filled with its average colour. */
  f("average", {}),
  /** Filter › Blur › Blur and Blur More: small fixed blurs. */
  f("blur", {}),
  f("blur-more", {}),
  f("box-blur", { radius: z.number().positive() }),
  /** Blurs with a round (disc) kernel, like a camera's out-of-focus highlights. */
  f("shape-blur", { radius: z.number().positive() }),
  /** Blurs only where neighbouring colours are within `threshold` (0..100), keeping edges. */
  f("smart-blur", { radius: z.number().positive(), threshold: z.number().min(0).max(100), mode: z.enum(["normal", "edge-only", "overlay-edge"]).optional() }),
  f("surface-blur", { radius: z.number().positive(), threshold: z.number().min(0).max(255) }),
  /** Depth-of-field blur: a depth map (image asset; white is near) and the depth in focus (0..1, default 1: the nearest). Without a map, a uniform lens blur. */
  f("lens-blur", { radius: z.number().positive(), depth: z.string().optional(), focus: z.number().min(0).max(1).optional() }),
  f("motion-blur", { angle: z.number(), distance: z.number().positive() }),
  /** Radial Blur: "spin" turns around the centre by `amount` degrees; "zoom" streaks towards it (`amount` 0..1). */
  f("radial-blur", { mode: z.enum(["spin", "zoom"]), amount: z.number().positive(), center: Point.optional() }),
  // ── Blur Gallery ──────────────────────────────────────────────────────────────────────
  /** Field Blur: blur strength set at points and blended between them. */
  f("field-blur", { points: z.array(z.object({ at: Point, radius: z.number().nonnegative() })).min(1).max(16) }),
  /** Iris Blur: sharp inside an ellipse (size as fractions of the box), blurring to `radius` outside. */
  f("iris-blur", { radius: z.number().positive(), center: Point.optional(), size: Point.optional(), feather: z.number().min(0).max(1).optional(), angle: z.number().optional() }),
  /** Tilt-Shift: a sharp band through `center` at `angle`, `band` and `transition` as fractions of the box height. */
  f("tilt-shift", { radius: z.number().positive(), center: Point.optional(), angle: z.number().optional(), band: z.number().min(0).max(1).optional(), transition: z.number().min(0).max(1).optional() }),
  /** Path Blur: smears along a curve through `path` points, `distance` px long. */
  f("path-blur", { path: z.array(Point).min(2).max(16), distance: z.number().positive() }),
  /** Spin Blur: turns `angle` degrees around `center`, inside an ellipse `size` (fractions of the box). */
  f("spin-blur", { angle: z.number().positive(), center: Point.optional(), size: Point.optional() }),
  // ── Distort ───────────────────────────────────────────────────────────────────────────
  /** Displace: shifts pixels by a map image (asset); mid-grey moves nothing. `scale` is the most px moved. */
  f("displace", { map: z.string(), scale: Point, fit: z.enum(["stretch", "tile"]).optional() }),
  f("pinch", { amount: z.number().min(-100).max(100) }),
  f("polar-coordinates", { mode: z.enum(["rect-to-polar", "polar-to-rect"]) }),
  f("ripple", { amount: z.number().min(-999).max(999), size: z.enum(["small", "medium", "large"]).optional() }),
  f("shear", { offsets: z.array(z.number()).min(2).max(16) }),
  f("spherize", { amount: z.number().min(-100).max(100), mode: z.enum(["normal", "horizontal", "vertical"]).optional() }),
  f("twirl", { angle: z.number(), radius: z.number().positive().optional(), center: Point.optional() }),
  f("wave", { amplitude: z.number(), wavelength: z.number().positive(), angle: z.number().optional() }),
  f("zigzag", { amount: z.number().min(-100).max(100), ridges: z.number().int().min(1).max(20), style: z.enum(["around-center", "out-from-center", "pond-ripples"]).optional() }),
  /** Ribbed glass refraction (Filter Gallery › Distort › Glass with a stripe texture). */
  f("glass", { size: z.number().positive(), amount: z.number(), angle: z.number().optional(), profile: z.enum(["ramp", "wave"]).optional() }),
  f("ocean-ripple", { size: z.number().min(1).max(15), magnitude: z.number().min(0).max(20) }),
  f("diffuse-glow", { graininess: z.number().min(0).max(10), glow: z.number().min(0).max(20), clear: z.number().min(0).max(20) }),
  /** Liquify, as data: each op warps around a point; `radius` is a fraction of the box's shorter side. */
  f("liquify", {
    ops: z
      .array(
        z.object({
          tool: z.enum(["forward-warp", "pucker", "bloat", "twirl-clockwise", "twirl-counterclockwise", "push-left"]),
          at: Point,
          /** Forward warp: where the point is pushed to. */
          to: Point.optional(),
          radius: z.number().positive(),
          /** 0..1 */
          strength: z.number().min(0).max(1).optional(),
        }),
      )
      .min(1)
      .max(32),
  }),
  /** Puppet Warp: pins move from `from` to `to`; the rest bends smoothly around them. */
  f("puppet-warp", { pins: z.array(z.object({ from: Point, to: Point })).min(1).max(32), rigidity: z.number().min(0).max(1).optional() }),
  /** Lens Correction: barrel (+) or pincushion (−) distortion, vignette, chromatic aberration. */
  f("lens-correction", {
    distortion: z.number().min(-100).max(100).optional(),
    vignette: z.number().min(-100).max(100).optional(),
    vignetteMidpoint: z.number().min(0).max(100).optional(),
    redCyan: z.number().min(-100).max(100).optional(),
    blueYellow: z.number().min(-100).max(100).optional(),
  }),
  // ── Noise ─────────────────────────────────────────────────────────────────────────────
  /** Add Noise / film grain: `amount` 0..1; `size` in px; colour unless monochrome. */
  f("noise", { amount: z.number().min(0).max(1), size: z.number().positive().optional(), monochrome: z.boolean().optional(), distribution: z.enum(["uniform", "gaussian"]).optional() }),
  f("despeckle", {}),
  /** Dust & Scratches: median where a pixel differs from it by more than `threshold` (0..255). */
  f("dust-and-scratches", { radius: z.number().int().min(1).max(16), threshold: z.number().min(0).max(255).optional() }),
  f("median", { radius: z.number().int().min(1).max(16) }),
  f("reduce-noise", { strength: z.number().min(0).max(10), preserveDetails: z.number().min(0).max(100).optional() }),
  // ── Pixelate ──────────────────────────────────────────────────────────────────────────
  f("color-halftone", { radius: z.number().min(2).max(127), angles: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional() }),
  f("crystallize", { size: z.number().min(3).max(300) }),
  f("facet", {}),
  f("fragment", {}),
  f("mezzotint", { type: z.enum(["fine-dots", "medium-dots", "grainy-dots", "coarse-dots", "short-lines", "medium-lines", "long-lines", "short-strokes", "medium-strokes", "long-strokes"]).optional() }),
  /** Mosaic. */
  f("pixelate", { size: z.number().positive() }),
  f("pointillize", { size: z.number().min(3).max(300), background: Color.optional() }),
  // ── Render ────────────────────────────────────────────────────────────────────────────
  /** Clouds: fills the layer's coverage with fractal noise between two colours (default black and white). */
  f("clouds", { colors: z.tuple([Color, Color]).optional(), scale: z.number().positive().optional(), seed: z.number().int().optional(), detail: z.number().int().min(1).max(8).optional() }),
  f("difference-clouds", { scale: z.number().positive().optional(), seed: z.number().int().optional() }),
  f("fibers", { variance: z.number().min(1).max(64), strength: z.number().min(1).max(64), colors: z.tuple([Color, Color]).optional(), seed: z.number().int().optional() }),
  f("lens-flare", { at: Point, brightness: z.number().min(10).max(300).optional(), lens: z.enum(["50-300mm", "35mm", "105mm", "movie-prime"]).optional() }),
  /** Lighting Effects: lights over the layer, with relief from its brightness (`height`, 0 for flat). */
  f("lighting-effects", {
    lights: z
      .array(
        z.object({
          type: z.enum(["spot", "point", "infinite"]),
          at: Point.optional(),
          /** Spot and infinite: where the light points, in degrees. */
          angle: z.number().optional(),
          color: Color.optional(),
          intensity: z.number().min(0).max(2).optional(),
          /** Point and spot reach, as a fraction of the box's larger side. */
          radius: z.number().positive().optional(),
        }),
      )
      .min(1)
      .max(8),
    ambient: z.number().min(0).max(1).optional(),
    height: z.number().min(0).max(100).optional(),
  }),
  // ── Sharpen ───────────────────────────────────────────────────────────────────────────
  /** Unsharp Mask: `amount` 0..5 (1 is 100%), `radius` px, `threshold` 0..255 skips low-contrast detail. */
  f("sharpen", { amount: z.number().min(0).max(5), radius: z.number().positive().optional(), threshold: z.number().min(0).max(255).optional() }),
  f("sharpen-more", {}),
  f("sharpen-edges", {}),
  /** Smart Sharpen: removes a gaussian, lens (disc) or motion blur, with noise reduction 0..100. */
  f("smart-sharpen", { amount: z.number().min(0).max(5), radius: z.number().positive(), reduceNoise: z.number().min(0).max(100).optional(), remove: z.enum(["gaussian", "lens", "motion"]).optional(), angle: z.number().optional() }),
  /** High Pass (Filter › Other): keeps detail finer than `radius` around mid-grey. Use in overlay/soft-light for sharpening. */
  f("high-pass", { radius: z.number().positive() }),
  // ── Stylize ───────────────────────────────────────────────────────────────────────────
  f("diffuse", { mode: z.enum(["normal", "darken-only", "lighten-only", "anisotropic"]).optional() }),
  f("emboss", { angle: z.number().optional(), height: z.number().min(1).max(10).optional(), amount: z.number().min(1).max(500).optional() }),
  f("extrude", { size: z.number().min(2).max(255), depth: z.number().min(1).max(255) }),
  f("find-edges", {}),
  f("glowing-edges", { width: z.number().min(1).max(14).optional(), brightness: z.number().min(0).max(20).optional() }),
  f("oil-paint", { stylization: z.number().min(0.1).max(10), cleanliness: z.number().min(0).max(10).optional(), shine: z.number().min(0).max(10).optional(), angle: z.number().optional() }),
  f("solarize", {}),
  f("tiles", { count: z.number().int().min(1).max(99), offset: z.number().min(1).max(99).optional() }),
  f("trace-contour", { level: z.number().min(0).max(255), edge: z.enum(["upper", "lower"]).optional() }),
  f("wind", { method: z.enum(["wind", "blast", "stagger"]).optional(), direction: z.enum(["left", "right"]).optional() }),
  f("cutout", { levels: z.number().int().min(2).max(8), simplicity: z.number().min(0).max(10).optional() }),
  f("poster-edges", { thickness: z.number().min(0).max(10).optional(), intensity: z.number().min(0).max(10).optional(), posterization: z.number().int().min(0).max(6).optional() }),
  f("halftone-pattern", { size: z.number().min(1).max(12), contrast: z.number().min(0).max(50).optional(), type: z.enum(["circle", "dot", "line"]).optional() }),
  // ── Video ─────────────────────────────────────────────────────────────────────────────
  f("de-interlace", { eliminate: z.enum(["odd", "even"]).optional(), create: z.enum(["duplication", "interpolation"]).optional() }),
  f("ntsc-colors", {}),
  // ── Other ─────────────────────────────────────────────────────────────────────────────
  /** Custom: a 5×5 (or 3×3) convolution kernel, divided by `scale`, plus `offset`. */
  f("custom", { kernel: z.array(z.array(z.number())), scale: z.number().optional(), offset: z.number().optional() }),
  f("hsb-hsl", { input: z.enum(["rgb", "hsb", "hsl"]), output: z.enum(["rgb", "hsb", "hsl"]) }),
  f("maximum", { radius: z.number().positive() }),
  f("minimum", { radius: z.number().positive() }),
  f("offset", { x: z.number(), y: z.number(), edges: z.enum(["wrap", "repeat", "transparent"]).optional() }),
  // ── Image › Adjustments that Photoshop applies to pixels (or as smart filters) ─────────
  /** Shadows/Highlights: lightens dark areas and darkens bright ones by their surroundings (`radius` px); `color` adjusts saturation where tones change. */
  f("shadows-highlights", {
    shadows: z.number().min(0).max(100),
    highlights: z.number().min(0).max(100).optional(),
    radius: z.number().positive().optional(),
    color: z.number().min(-100).max(100).optional(),
  }),
  f("desaturate", {}),
  /** Equalize: spreads the layer's tones evenly from black to white. */
  f("equalize", {}),
  /** Match Color: moves the layer's colour and tone towards a source image's (asset); `neutralize` removes a colour cast instead. */
  f("match-color", {
    source: z.string().optional(),
    luminance: z.number().min(1).max(200).optional(),
    intensity: z.number().min(1).max(200).optional(),
    fade: z.number().min(0).max(100).optional(),
    neutralize: z.boolean().optional(),
  }),
  /** Replace Color: shifts hue, saturation and lightness of colours within `fuzziness` of `color`. */
  f("replace-color", {
    color: Color,
    fuzziness: z.number().min(0).max(200),
    hue: z.number().min(-180).max(180).optional(),
    saturation: z.number().min(-100).max(100).optional(),
    lightness: z.number().min(-100).max(100).optional(),
  }),
  // ── Camera Raw ────────────────────────────────────────────────────────────────────────
  /** Camera Raw Filter: the Basic panel and more, each −100..100 (exposure in stops, −5..5). */
  f("camera-raw", {
    exposure: z.number().min(-5).max(5).optional(),
    contrast: z.number().min(-100).max(100).optional(),
    highlights: z.number().min(-100).max(100).optional(),
    shadows: z.number().min(-100).max(100).optional(),
    whites: z.number().min(-100).max(100).optional(),
    blacks: z.number().min(-100).max(100).optional(),
    temperature: z.number().min(-100).max(100).optional(),
    tint: z.number().min(-100).max(100).optional(),
    vibrance: z.number().min(-100).max(100).optional(),
    saturation: z.number().min(-100).max(100).optional(),
    clarity: z.number().min(-100).max(100).optional(),
    texture: z.number().min(-100).max(100).optional(),
    dehaze: z.number().min(-100).max(100).optional(),
    vignette: z.number().min(-100).max(100).optional(),
    grain: z.number().min(0).max(100).optional(),
  }),
]);
export type Filter = z.infer<typeof Filter>;
export type FilterKind = Filter["kind"];

/** Image assets a filter reads (displacement and depth maps, Match Color sources). */
export function filterAssets(filter: Filter): string[] {
  if (filter.kind === "displace") return [filter.map];
  if (filter.kind === "lens-blur" && filter.depth) return [filter.depth];
  if (filter.kind === "match-color" && filter.source) return [filter.source];
  return [];
}
