import { z } from "zod";
import { BlendMode, Color } from "./primitives.js";

// Smart filters: Photoshop's Filter menu as data. They run in order on a layer's own pixels,
// before its mask, opacity and blend, and stay editable. Every filter takes "opacity" and
// "blend" (Photoshop's Edit › Fade), which mix the result back over the layer's unfiltered
// pixels. Positions ("center", "at", points) are [x, y] fractions of the layer's box; sizes
// are pixels unless noted.

const Point = z.tuple([z.number(), z.number()]);
/** A retouching spot: centre and size as fractions of the layer's box, an ellipse (default) or rectangle, a soft edge in pixels. */
const Spot = z.object({ at: Point, size: Point, shape: z.enum(["ellipse", "rect"]).optional(), feather: z.number().nonnegative().optional() });
const Fade = { opacity: z.number().min(0).max(1).optional(), blend: BlendMode.optional() };
const f = <K extends string, T extends z.ZodRawShape>(kind: K, shape: T) => z.object({ kind: z.literal(kind), ...shape, ...Fade });

/** Where a Filter Gallery light comes from, as in Photoshop's Light menu. */
const Light = z.enum(["top", "top-right", "right", "bottom-right", "bottom", "bottom-left", "left", "top-left"]);
/** Filter Gallery's surface textures, shared by Texturizer, Rough Pastels, Underpainting and Conté Crayon. */
const Surface = {
  texture: z.enum(["canvas", "burlap", "brick", "sandstone"]).optional(),
  /** 50..200 (%) */
  scaling: z.number().min(50).max(200).optional(),
  relief: z.number().min(0).max(50).optional(),
  light: Light.optional(),
  invert: z.boolean().optional(),
};
/** The Sketch filters draw in Photoshop's foreground and background colours: [foreground, background], black and white by default. */
const Inks = { colors: z.tuple([Color, Color]).optional() };
const Direction = z.enum(["right-diagonal", "horizontal", "left-diagonal", "vertical"]);
const int = (lo: number, hi: number) => z.number().int().min(lo).max(hi);
const num = (lo: number, hi: number) => z.number().min(lo).max(hi);

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
  /**
   * Adaptive Wide Angle: "fisheye" straightens a fisheye photo into a normal (rectilinear) one;
   * "perspective" eases the stretched edges of a wide rectilinear photo (to a stereographic view);
   * "full-spherical" turns a 2:1 360° panorama into a normal view looking towards `yaw` and `pitch`.
   * `focalLength` is in mm for the full-frame (36 mm) width, times `cropFactor`; `scale` is 50..150 (%).
   */
  f("adaptive-wide-angle", {
    correction: z.enum(["fisheye", "perspective", "full-spherical"]),
    focalLength: z.number().positive().max(300).optional(),
    cropFactor: z.number().positive().max(10).optional(),
    scale: num(50, 150).optional(),
    yaw: z.number().optional(),
    pitch: num(-90, 90).optional(),
  }),
  /**
   * Vanishing Point: work in perspective on a flat surface (a wall, a floor, a box side), the
   * `plane`'s corners given clockwise from the top left, as fractions of the layer's box. Positions
   * inside the plane are [u, v] fractions of it. A stamp copies the patch around `from` to `to` (Clone
   * Stamp in perspective, `size` a fraction of the plane; `heal` matches the light); a paste places an
   * image asset across `rect` [u0, v0, u1, v1] of the plane, `tile` times across if set.
   */
  f("vanishing-point", {
    plane: z.tuple([Point, Point, Point, Point]),
    stamps: z
      .array(z.object({ from: Point, to: Point, size: z.number().positive().max(1), heal: z.boolean().optional() }))
      .max(32)
      .optional(),
    paste: z
      .array(z.object({ asset: z.string(), rect: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), tile: z.number().positive().max(64).optional(), opacity: z.number().min(0).max(1).optional() }))
      .max(8)
      .optional(),
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
  /**
   * Flame: fire along `path` (points as fractions of the box). "one" is a single flame following the
   * path; "multiple" sets flames along it every `interval` px, rising at `angle` (degrees, 90 up);
   * "candle" is one small flame at the first point. `length` and `width` are px; `turbulence` and
   * `jag` 0..100; `color` tints it (natural fire colours by default).
   */
  f("flame", {
    path: z.array(Point).min(1).max(16),
    type: z.enum(["one", "multiple", "candle"]).optional(),
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    interval: z.number().positive().optional(),
    angle: z.number().optional(),
    turbulence: num(0, 100).optional(),
    jag: num(0, 100).optional(),
    color: Color.optional(),
    seed: z.number().int().optional(),
  }),
  /** Picture Frame: a frame drawn `margin` px inside the layer's edges, `width` px wide (6% of the shorter side by default). */
  f("picture-frame", {
    style: z.enum(["flat", "bevel", "double", "wood", "gold", "stripes"]).optional(),
    margin: z.number().nonnegative().optional(),
    width: z.number().positive().optional(),
    color: Color.optional(),
  }),
  /**
   * Tree: a tree growing from `at` (default the bottom centre), `height` a fraction of the box's
   * height. `leaves` 0..100 is how many; `leafSize` and `thickness` are percentages (100 normal).
   * Lit from `light` degrees (135: the top left). Each `seed` grows a different tree of the type.
   */
  f("tree", {
    type: z.enum(["oak", "maple", "pine", "willow", "birch", "bare"]).optional(),
    at: Point.optional(),
    height: num(0.05, 1.5).optional(),
    leaves: num(0, 100).optional(),
    leafSize: num(10, 300).optional(),
    thickness: num(10, 300).optional(),
    leafColor: Color.optional(),
    trunkColor: Color.optional(),
    light: z.number().optional(),
    seed: z.number().int().optional(),
  }),
  /**
   * Relight: new lights on the photo's own shapes. Without a `depth` map (image asset, white is
   * near), shapes come from the photo's tones at the scale `smoothness` sets (0..100). `ambient`
   * −100..100 darkens (or brightens) the existing light first. Each light: `at`, `color`,
   * `intensity` 0..2, `radius` (fraction of the box's larger side) and `height` 0..1 above the surface.
   */
  f("relight", {
    lights: z
      .array(z.object({ at: Point, color: Color.optional(), intensity: num(0, 2).optional(), radius: z.number().positive().optional(), height: num(0, 1).optional() }))
      .min(1)
      .max(8),
    ambient: num(-100, 100).optional(),
    depth: z.string().optional(),
    smoothness: num(0, 100).optional(),
  }),
  // ── Sharpen ───────────────────────────────────────────────────────────────────────────
  /** Unsharp Mask: `amount` 0..5 (1 is 100%), `radius` px, `threshold` 0..255 skips low-contrast detail. */
  f("sharpen", { amount: z.number().min(0).max(5), radius: z.number().positive().optional(), threshold: z.number().min(0).max(255).optional() }),
  f("sharpen-more", {}),
  f("sharpen-edges", {}),
  /** Smart Sharpen: removes a gaussian, lens (disc) or motion blur, with noise reduction 0..100. */
  f("smart-sharpen", { amount: z.number().min(0).max(5), radius: z.number().positive(), reduceNoise: z.number().min(0).max(100).optional(), remove: z.enum(["gaussian", "lens", "motion"]).optional(), angle: z.number().optional() }),
  /** High Pass (Filter › Other): keeps detail finer than `radius` around mid-grey. Use in overlay/soft-light for sharpening. */
  /** High Pass: detail around 50% grey. `scale` multiplies the detail (0.5 for 8-bit frequency separation, like Apply Image's scale 2, so strong detail doesn't clip). */
  f("high-pass", { radius: z.number().positive(), scale: z.number().positive().max(4).optional() }),
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
  // ── Filter Gallery › Artistic (Cutout and Poster Edges are above) ─────────────────────
  // Every Filter Gallery field is optional, with Photoshop's default, and uses its range.
  f("colored-pencil", { width: int(1, 24).optional(), pressure: int(0, 15).optional(), paper: int(0, 50).optional() }),
  /** `roughness` is Photoshop's Texture (1..3). */
  f("dry-brush", { size: int(0, 10).optional(), detail: int(0, 10).optional(), roughness: int(1, 3).optional() }),
  f("film-grain", { grain: int(0, 20).optional(), highlight: int(0, 20).optional(), intensity: int(0, 10).optional() }),
  f("fresco", { size: int(0, 10).optional(), detail: int(0, 10).optional(), roughness: int(1, 3).optional() }),
  /** Neon Glow: the image in the foreground and background colours, glowing in `color`; a negative `size` glows in the shadows. */
  f("neon-glow", { size: int(-24, 24).optional(), brightness: int(0, 50).optional(), color: Color.optional(), ...Inks }),
  f("paint-daubs", { size: int(1, 50).optional(), sharpness: int(0, 40).optional(), brush: z.enum(["simple", "light-rough", "dark-rough", "wide-sharp", "wide-blurry", "sparkle"]).optional() }),
  f("palette-knife", { size: int(1, 50).optional(), detail: int(1, 3).optional(), softness: int(0, 10).optional() }),
  f("plastic-wrap", { highlight: int(0, 20).optional(), detail: int(1, 15).optional(), smoothness: int(1, 15).optional() }),
  f("rough-pastels", { length: int(0, 40).optional(), detail: int(1, 20).optional(), ...Surface }),
  f("smudge-stick", { length: int(0, 10).optional(), highlight: int(0, 20).optional(), intensity: int(0, 10).optional() }),
  f("sponge", { size: int(0, 10).optional(), definition: int(0, 25).optional(), smoothness: int(1, 15).optional() }),
  /** `coverage` is Photoshop's Texture Coverage. */
  f("underpainting", { size: int(0, 40).optional(), coverage: int(0, 40).optional(), ...Surface }),
  /** `shadow` is Shadow Intensity; `roughness` is Texture (1..3). */
  f("watercolor", { detail: int(1, 14).optional(), shadow: int(0, 10).optional(), roughness: int(1, 3).optional() }),
  // ── Filter Gallery › Brush Strokes ────────────────────────────────────────────────────
  f("accented-edges", { width: int(1, 14).optional(), brightness: int(0, 50).optional(), smoothness: int(1, 15).optional() }),
  /** `balance` is Direction Balance (0..100). */
  f("angled-strokes", { balance: int(0, 100).optional(), length: int(3, 50).optional(), sharpness: int(0, 10).optional() }),
  f("crosshatch", { length: int(3, 50).optional(), sharpness: int(0, 20).optional(), strength: int(1, 3).optional() }),
  /** `black` and `white` are Black and White Intensity. */
  f("dark-strokes", { balance: int(0, 10).optional(), black: int(0, 10).optional(), white: int(0, 10).optional() }),
  /** `dark` and `light` are Dark and Light Intensity. */
  f("ink-outlines", { length: int(1, 50).optional(), dark: int(0, 50).optional(), light: int(0, 50).optional() }),
  /** `radius` is Spray Radius. */
  f("spatter", { radius: int(0, 25).optional(), smoothness: int(1, 15).optional() }),
  f("sprayed-strokes", { length: int(0, 20).optional(), radius: int(0, 25).optional(), direction: Direction.optional() }),
  f("sumi-e", { width: int(3, 15).optional(), pressure: int(0, 15).optional(), contrast: int(0, 40).optional() }),
  // ── Filter Gallery › Sketch (Halftone Pattern is above) ───────────────────────────────
  f("bas-relief", { detail: int(1, 15).optional(), smoothness: int(1, 15).optional(), light: Light.optional(), ...Inks }),
  /** `charcoal` and `chalk` are Charcoal Area and Chalk Area. */
  f("chalk-charcoal", { charcoal: int(0, 20).optional(), chalk: int(0, 20).optional(), pressure: int(0, 5).optional(), ...Inks }),
  /** `balance` is Light/Dark Balance (0..100). */
  f("charcoal", { thickness: int(1, 7).optional(), detail: int(0, 5).optional(), balance: int(0, 100).optional(), ...Inks }),
  f("chrome", { detail: int(0, 10).optional(), smoothness: int(0, 10).optional() }),
  /** `foreground` and `background` are Foreground and Background Level. */
  f("conte-crayon", { foreground: int(1, 15).optional(), background: int(1, 15).optional(), ...Surface, ...Inks }),
  f("graphic-pen", { length: int(1, 15).optional(), balance: int(0, 100).optional(), direction: Direction.optional(), ...Inks }),
  /** `balance` is Image Balance. */
  f("note-paper", { balance: int(0, 50).optional(), graininess: int(0, 20).optional(), relief: int(0, 25).optional(), ...Inks }),
  f("photocopy", { detail: int(1, 24).optional(), darkness: int(1, 50).optional(), ...Inks }),
  f("plaster", { balance: int(0, 50).optional(), smoothness: int(1, 15).optional(), light: Light.optional(), ...Inks }),
  /** `foreground` and `background` are Foreground and Background Level. */
  f("reticulation", { density: int(0, 50).optional(), foreground: int(0, 50).optional(), background: int(0, 50).optional(), ...Inks }),
  /** `balance` is Light/Dark Balance (0..50). */
  f("stamp", { balance: int(0, 50).optional(), smoothness: int(1, 50).optional(), ...Inks }),
  f("torn-edges", { balance: int(0, 50).optional(), smoothness: int(1, 15).optional(), contrast: int(1, 25).optional(), ...Inks }),
  /** `length` is Fiber Length. */
  f("water-paper", { length: int(3, 50).optional(), brightness: int(0, 100).optional(), contrast: int(0, 100).optional() }),
  // ── Filter Gallery › Texture ──────────────────────────────────────────────────────────
  /** `spacing`, `depth` and `brightness` are Crack Spacing, Depth and Brightness. */
  f("craquelure", { spacing: int(2, 100).optional(), depth: int(0, 10).optional(), brightness: int(0, 10).optional() }),
  f("grain", {
    intensity: int(0, 100).optional(),
    contrast: int(0, 100).optional(),
    type: z.enum(["regular", "soft", "sprinkles", "clumped", "contrasty", "enlarged", "stippled", "horizontal", "vertical", "speckle"]).optional(),
  }),
  /** `size`, `grout` and `lighten` are Tile Size, Grout Width and Lighten Grout. */
  f("mosaic-tiles", { size: int(2, 100).optional(), grout: int(1, 15).optional(), lighten: int(0, 10).optional() }),
  f("patchwork", { size: int(0, 10).optional(), relief: int(0, 25).optional() }),
  /** Stained Glass: cells of one colour with `border` lines in `color` (the foreground colour, black by default), lit from the centre by `intensity` (Light Intensity). */
  f("stained-glass", { size: int(2, 50).optional(), border: int(1, 20).optional(), intensity: int(0, 10).optional(), color: Color.optional() }),
  f("texturizer", Surface),
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
  /**
   * Color to Alpha: turns `color` (white by default) into transparency, and the colours near it
   * partly transparent, keeping what's left of them, like dropping white paper behind ink. Colours
   * closer than `transparency` (0..1) go fully clear; those beyond `opacity` stay solid.
   */
  f("color-to-alpha", { color: Color.optional(), transparency: num(0, 1).optional(), opacity: num(0, 1).optional() }),
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
  // ── Retouching (Edit › Content-Aware Fill, Clone Stamp, Healing Brush) ─────────────────
  /** Content-Aware Fill: replaces the spots with texture found elsewhere in the layer. */
  f("content-aware-fill", { spots: z.array(Spot).min(1).max(64) }),
  /** Clone Stamp: paints the spots with the pixels `offset` [x, y] px away. */
  f("clone", { spots: z.array(Spot).min(1).max(64), offset: Point }),
  /**
   * Healing Brush / Spot Healing: like Clone Stamp from `offset`, or Content-Aware Fill without one,
   * then blended so the light and colour match the surroundings. For blemishes, dust, wires and stray hairs.
   */
  f("heal", { spots: z.array(Spot).min(1).max(64), offset: Point.optional() }),
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
  if (filter.kind === "relight" && filter.depth) return [filter.depth];
  if (filter.kind === "vanishing-point") return (filter.paste ?? []).map((p) => p.asset);
  return [];
}
