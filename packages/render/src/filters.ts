import type { Filter } from "@gesso/core";
import type { CanvasKit, Image, RuntimeEffect, Shader } from "canvaskit-wasm";
import {
  blank,
  boxBlur,
  boxPlane,
  clamp,
  copyRaster,
  discBlur,
  fbm,
  fromPlanes,
  gaussBlur,
  guided,
  hash,
  kuwahara,
  len,
  luma,
  mapColor,
  median,
  morph,
  planes,
  readRaster,
  reduced,
  remap,
  rgbToLab,
  labToRgb,
  shiftHsl,
  sample,
  samplePlane,
  smoothstep,
  valueNoise,
  writeRaster,
  type Raster,
} from "./cpu.js";
import type { Box } from "./layout.js";
import { blendPlanes, contentAwareFill, heal, shifted, spotMask } from "./retouch.js";
import { directionField, samplePath, shaderEffect, shearRows } from "./shaders.js";

// Photoshop's Filter menu. Most filters work on the layer's pixels on the CPU (see cpu.ts);
// a few long blurs and distortions that were already shaders stay on CanvasKit.
// Sizes in filter parameters are artboard units, scaled by the render scale `k`; patterns
// (noise, cells, tiles) are anchored to the artboard so they don't crawl as layers move.

/** What filters need from the compositor. Images passed in are consumed. */
export interface FilterKit {
  ck: CanvasKit;
  scale: number;
  images: Map<string, Image>;
  warnings: string[];
  runShader(image: Image, f: number, make: (child: Shader, w: number, h: number) => { shader: Shader; extras?: Array<{ delete(): void }> }): Image;
  blur(image: Image, radius: number, keep?: boolean): Image;
}

type Of<K extends Filter["kind"]> = Extract<Filter, { kind: K }>;
type Pt = [number, number];

/** Where a filter runs: the layer's box, the image's offset on the artboard (output px) and the scale. */
type Ctx = {
  kit: FilterKit;
  k: number;
  box: Box;
  ox: number;
  oy: number;
  /** A point given as fractions of the layer's box, in the image's pixels (the centre by default). */
  at: (p?: Pt) => Pt;
  minSide: number;
};

// Grain stays a CanvasKit shader (one sample per pixel), matching earlier renders.
const SRC = {
  noise: `uniform shader img; uniform float amount; uniform float size; uniform float2 origin; uniform float mono; uniform float gauss;
    float hash(float2 q) { return fract(sin(dot(q, float2(12.9898, 78.233))) * 43758.5453); }
    float n1(float2 q) { return gauss > 0.5 ? (hash(q) + hash(q + 3.1) + hash(q + 7.7)) * 0.6667 - 1.0 : hash(q) - 0.5; }
    half4 main(float2 p) { half4 c = img.eval(p); float2 cell = floor((p + origin) / size);
      float n = n1(cell); float3 g = mono > 0.5 ? float3(n) : float3(n, n1(cell + 17.31), n1(cell + 41.73));
      return half4(clamp(c.rgb + half3(g * amount * 2.0) * c.a, 0.0, c.a), c.a); }`,
};

const cache = new WeakMap<CanvasKit, Map<string, RuntimeEffect>>();
function effect(ck: CanvasKit, name: keyof typeof SRC): RuntimeEffect {
  let m = cache.get(ck);
  if (!m) cache.set(ck, (m = new Map()));
  let e = m.get(name);
  if (!e) {
    const errors: string[] = [];
    e = ck.RuntimeEffect.Make(SRC[name], (err) => errors.push(err)) ?? undefined;
    if (!e) throw new Error(`Could not compile the ${name} filter: ${errors.join("; ")}`);
    m.set(name, e);
  }
  return e;
}

// ── Dispatch ──────────────────────────────────────────────────────────────────────────────

/**
 * Applies one filter to an image placed at (x, y) in output pixels; `box` is the layer's box in
 * artboard units. The image is consumed. Opacity and blend (Edit › Fade) mix the result over the input.
 */
export function applyFilter(kit: FilterKit, image: Image, filter: Filter, box: Box, x: number, y: number): Image {
  const fade = (filter.opacity ?? 1) < 1 || (filter.blend !== undefined && filter.blend !== "normal");
  if (!fade) return run(kit, image, filter, box, x, y);
  const original = copy(kit, image);
  const result = run(kit, image, filter, box, x, y);
  return fadeOver(kit, original, result, filter.opacity ?? 1, filter.blend);
}

function run(kit: FilterKit, image: Image, filter: Filter, box: Box, x: number, y: number): Image {
  const { ck } = kit;
  const k = kit.scale;
  const [w, h] = [image.width(), image.height()];
  const at = (c?: Pt, f = 1): Pt => [((box.x + (c?.[0] ?? 0.5) * box.w) * k - x) / f, ((box.y + (c?.[1] ?? 0.5) * box.h) * k - y) / f];
  const ctx: Ctx = { kit, k, box, ox: x, oy: y, at: (p) => at(p), minSide: Math.min(box.w, box.h) * k };
  // Long blurs run at reduced resolution, where their reach is about 24 pixels.
  const reduce = (reach: number) => Math.max(1, Math.min(8, reach / 24));
  const js = (fn: (r: Raster) => Raster) => writeRaster(ck, fn(readRaster(ck, image)));
  const named = (name: Parameters<typeof shaderEffect>[1], uniforms: number[], f = 1) =>
    kit.runShader(image, f, (child) => ({ shader: shaderEffect(ck, name).makeShaderWithChildren(uniforms, [child]) }));

  switch (filter.kind) {
    // ── Blur
    case "gaussian-blur":
      return kit.blur(image, filter.radius);
    case "blur":
      return kit.blur(image, 0.8);
    case "blur-more":
      return kit.blur(image, 2);
    case "average":
      return js(average);
    case "box-blur":
      return js((r) => boxBlur(r, filter.radius * k));
    case "shape-blur":
      return js((r) => disc(r, filter.radius * k));
    case "surface-blur":
      return js((r) => guided(r, Math.max(1, filter.radius * k), (filter.threshold / 255) ** 2));
    case "smart-blur":
      return js((r) => smartBlur(r, filter, k));
    case "reduce-noise":
      return js((r) => guided(r, (1 + filter.strength * 0.5) * k, (((4 + filter.strength * 4) * (1.1 - (filter.preserveDetails ?? 60) / 100)) / 255) ** 2));
    case "lens-blur":
      return lensBlur(ctx, image, filter);
    case "field-blur":
    case "iris-blur":
    case "tilt-shift":
      return galleryBlur(ctx, image, filter);
    case "motion-blur": {
      const f = reduce(filter.distance * k);
      const a = (filter.angle * Math.PI) / 180;
      const d = (filter.distance * k) / f;
      return named("motion", [Math.cos(a) * d, -Math.sin(a) * d], f);
    }
    case "path-blur": {
      const f = reduce(filter.distance * k);
      return kit.runShader(image, f, (child, sw, sh) => {
        // Path points are fractions of the layer's box; the field is built in the reduced image's pixels.
        const path = samplePath(filter.path.map((p) => at(p, f)));
        const field = ck.MakeImage(rgbaInfo(ck, sw, sh), directionField(path, sw, sh), sw * 4)!;
        const fieldShader = field.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None);
        return { shader: shaderEffect(ck, "path").makeShaderWithChildren([(filter.distance * k) / f], [child, fieldShader]), extras: [field, fieldShader] };
      });
    }
    case "radial-blur":
    case "spin-blur": {
      const spin = filter.kind === "spin-blur" || filter.mode === "spin";
      const amount = filter.kind === "spin-blur" ? filter.angle : filter.amount;
      const [cx, cy] = at(filter.center);
      // How far the farthest corner moves sets the working resolution.
      const far = Math.max(...[[0, 0], [w, 0], [0, h], [w, h]].map(([px, py]) => len(px! - cx, py! - cy)));
      const angle = (Math.min(amount, 360) * Math.PI) / 180;
      const original = filter.kind === "spin-blur" ? readRaster(ck, image, false) : undefined;
      const f = reduce(spin ? far * angle : far * Math.min(amount, 1));
      const spun = kit.runShader(image, f, (child) => ({
        shader: spin
          ? shaderEffect(ck, "spin").makeShaderWithChildren([...at(filter.center, f), angle], [child])
          : shaderEffect(ck, "zoom").makeShaderWithChildren([...at(filter.center, f), Math.min(amount, 1)], [child]),
      }));
      if (!original || filter.kind !== "spin-blur") return spun;
      // Blur Gallery's spin blur: inside an ellipse, fading out across its rim.
      const [sx, sy] = [((filter.size?.[0] ?? 0.4) * box.w * k) / 2, ((filter.size?.[1] ?? 0.4) * box.h * k) / 2];
      return writeRaster(ck, mix(original, readRaster(ck, spun), (px, py) => 1 - smoothstep(0.8, 1.2, len((px - cx) / sx, (py - cy) / sy))));
    }
    // ── Distort
    case "displace":
      return displace(ctx, image, filter);
    case "pinch":
      return js((r) => pinch(ctx, r, filter.amount / 100));
    case "spherize":
      return js((r) => spherize(ctx, r, filter));
    case "polar-coordinates":
      return js((r) => polar(r, filter.mode === "rect-to-polar"));
    case "ripple":
      return js((r) => ripple(ctx, r, filter));
    case "zigzag":
      return js((r) => zigzag(ctx, r, filter));
    case "ocean-ripple":
      return js((r) => ocean(ctx, r, filter));
    case "diffuse-glow":
      return js((r) => diffuseGlow(ctx, r, filter));
    case "glass": {
      const a = ((filter.angle ?? 0) * Math.PI) / 180;
      return named("glass", [Math.cos(a), Math.sin(a), x, y, filter.size * k, filter.amount * k, filter.profile === "wave" ? 1 : 0]);
    }
    case "twirl":
      return named("twirl", [...at(filter.center), (filter.angle * Math.PI) / 180, (filter.radius ?? 0.5) * ctx.minSide]);
    case "wave": {
      const a = ((filter.angle ?? 0) * Math.PI) / 180;
      return named("wave", [filter.amplitude * k, filter.wavelength * k, Math.cos(a), -Math.sin(a), x, y]);
    }
    case "shear": {
      const range = Math.max(1, ...filter.offsets.map((o) => Math.abs(o) * k));
      return kit.runShader(image, 1, (child) => {
        const rows = ck.MakeImage(rgbaInfo(ck, 1, h), shearRows(filter.offsets.map((o) => o * k), box.y * k - y, Math.max(1, box.h * k), h, range), 4)!;
        const rowShader = rows.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Nearest, ck.MipmapMode.None);
        return { shader: shaderEffect(ck, "shear").makeShaderWithChildren([range], [child, rowShader]), extras: [rowShader, rows] };
      });
    }
    case "liquify":
      return js((r) => warpField(r, (fw, fh, sx, sy) => liquifyField(ctx, filter, fw, fh, sx, sy)));
    case "puppet-warp":
      return js((r) => warpField(r, (fw, fh, sx, sy) => puppetField(ctx, filter, fw, fh, sx, sy)));
    case "lens-correction":
      return js((r) => lensCorrection(ctx, r, filter));
    // ── Noise
    case "noise":
      return kit.runShader(image, 1, (child) => ({
        shader: effect(ck, "noise").makeShaderWithChildren([filter.amount, Math.max(1, (filter.size ?? 1) * k), x, y, filter.monochrome === false ? 0 : 1, filter.distribution === "gaussian" ? 1 : 0], [child]),
      }));
    case "median":
      return bytes(kit, image, (px, iw, ih) => median(px, iw, ih, Math.max(1, Math.round(filter.radius * k))));
    case "despeckle":
      return bytes(kit, image, (px, iw, ih) => despeckle(px, iw, ih, Math.max(1, Math.round(k))));
    case "dust-and-scratches":
      return bytes(kit, image, (px, iw, ih) => dust(px, iw, ih, Math.max(1, Math.round(filter.radius * k)), filter.threshold ?? 0));
    // ── Pixelate
    case "pixelate":
      return named("pixelate", [Math.max(1, filter.size * k), x, y]);
    case "color-halftone":
      return js((r) => colorHalftone(ctx, r, filter));
    case "crystallize":
      return js((r) => cells(ctx, r, filter.size * k, undefined));
    case "pointillize":
      return js((r) => cells(ctx, r, filter.size * k, rgb01(filter.background ?? "#FFFFFF")));
    case "facet":
      return js((r) => kuwahara(r, 2 * k));
    case "fragment":
      return js((r) => fragment(r, 4 * k));
    case "mezzotint":
      return js((r) => mezzotint(ctx, r, filter));
    // ── Render
    case "clouds":
    case "difference-clouds":
    case "fibers":
      return js((r) => clouds(ctx, r, filter));
    case "lens-flare":
      return js((r) => lensFlare(ctx, r, filter));
    case "lighting-effects":
      return js((r) => lighting(ctx, r, filter));
    // ── Sharpen
    case "sharpen": {
      const soft = soften(kit, image, filter.radius ?? 1);
      return js((r) => unsharp(r, soft, filter.amount, filter.threshold ?? 0));
    }
    case "sharpen-more": {
      const soft = soften(kit, image, 1);
      return js((r) => unsharp(r, soft, 1.6, 0));
    }
    case "sharpen-edges": {
      const soft = soften(kit, image, 1);
      return js((r) => unsharp(r, soft, 1.2, 12));
    }
    case "smart-sharpen": {
      const soft =
        filter.remove === "lens"
          ? disc(readRaster(ck, image, false), filter.radius * k)
          : filter.remove === "motion"
            ? readRaster(ck, motionCopy(kit, image, filter.angle ?? 0, filter.radius * 2))
            : soften(kit, image, filter.radius);
      return js((r) => unsharp(r, soft, filter.amount, ((filter.reduceNoise ?? 10) / 100) * 12));
    }
    case "high-pass": {
      // The same blur as Gaussian Blur, as in Photoshop, so a high pass over a blurred copy rebuilds the original exactly (frequency separation).
      const soft = readRaster(kit.ck, kit.blur(image, filter.radius, true));
      return js((r) => highPass(r, soft, filter.scale ?? 1));
    }
    // ── Stylize
    case "diffuse":
      return js((r) => diffuse(ctx, r, filter.mode ?? "normal"));
    case "emboss":
      return js((r) => emboss(ctx, r, filter));
    case "extrude":
      return js((r) => extrude(ctx, r, filter));
    case "find-edges":
      return js((r) => edges(r, k, false, 1));
    case "glowing-edges":
      return js((r) => edges(r, (filter.width ?? 2) * k, true, ((filter.brightness ?? 6) / 6) * 1.5));
    case "oil-paint":
      return js((r) => oilPaint(ctx, r, filter));
    case "solarize":
      return js((r) =>
        mapColor(r, (c) => {
          for (let j = 0; j < 3; j++) if (c[j]! > 0.5) c[j] = 1 - c[j]!;
        }),
      );
    case "tiles":
      return js((r) => tiles(ctx, r, filter));
    case "trace-contour":
      return js((r) => traceContour(r, filter.level / 255, filter.edge !== "lower"));
    case "wind":
      return js((r) => wind(ctx, r, filter));
    case "cutout":
      return js((r) => posterize(kuwahara(r, Math.max(1, (filter.simplicity ?? 4) * 0.8 * k)), filter.levels));
    case "poster-edges":
      return js((r) => posterEdges(r, filter, k));
    case "halftone-pattern":
      return js((r) => halftonePattern(ctx, r, filter));
    // ── Video
    case "de-interlace":
      return js((r) => deinterlace(r, filter.eliminate !== "even", filter.create !== "duplication"));
    case "ntsc-colors":
      return js((r) => mapColor(r, ntsc));
    // ── Other
    case "custom":
      return js((r) => convolve(r, filter));
    case "hsb-hsl":
      return js((r) => mapColor(r, hsbHsl(filter.input, filter.output)));
    case "maximum":
    case "minimum":
      return js((r) => morph(r, filter.radius * k, filter.kind === "maximum"));
    case "offset":
      return js((r) => offset(r, filter.x * k, filter.y * k, filter.edges ?? "wrap"));
    case "camera-raw":
      return cameraRaw(ctx, image, filter);
    // ── Image › Adjustments
    case "shadows-highlights":
      return js((r) => shadowsHighlights(r, filter, k));
    case "desaturate":
      return js((r) =>
        mapColor(r, (c) => {
          c.fill((Math.max(c[0]!, c[1]!, c[2]!) + Math.min(c[0]!, c[1]!, c[2]!)) / 2);
        }),
      );
    case "equalize":
      return js(equalize);
    case "match-color":
      return matchColor(ctx, image, filter);
    case "replace-color":
      return js((r) => replaceColor(r, filter));
    // ── Retouching
    case "content-aware-fill":
    case "clone":
    case "heal":
      return js((r) => retouch(ctx, r, filter));
  }
}

/** How far a filter can move or spread pixels beyond the layer, in artboard units. */
export function filterReach(filter: Filter, box: Box): number {
  switch (filter.kind) {
    case "gaussian-blur":
      return 3 * filter.radius;
    case "blur":
      return 3;
    case "blur-more":
      return 6;
    case "box-blur":
    case "shape-blur":
    case "lens-blur":
    case "maximum":
      return filter.radius;
    case "iris-blur":
    case "tilt-shift":
      return filter.radius * 3;
    case "field-blur":
      return Math.max(...filter.points.map((p) => p.radius)) * 3;
    case "motion-blur":
    case "path-blur":
      return filter.distance / 2;
    case "radial-blur":
      return (len(box.w, box.h) / 2) * (filter.mode === "spin" ? Math.min(1, (filter.amount * Math.PI) / 180) : Math.min(1, filter.amount));
    case "wave":
      return Math.abs(filter.amplitude);
    case "shear":
      return Math.max(...filter.offsets.map(Math.abs));
    case "displace":
      return Math.max(Math.abs(filter.scale[0]), Math.abs(filter.scale[1]));
    case "wind":
      return filter.method === "blast" ? 40 : 14;
    case "shadows-highlights":
      return 0;
    default:
      // The rest work within the layer, repeating its edges.
      return 0;
  }
}

// ── Plumbing ─────────────────────────────────────────────────────────────────────────────

const rgbaInfo = (ck: CanvasKit, width: number, height: number) => ({ width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
const rgb01 = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
const BLEND: Record<string, string> = {
  normal: "SrcOver",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "ColorDodge",
  "color-burn": "ColorBurn",
  "hard-light": "HardLight",
  "soft-light": "SoftLight",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

function copy(kit: FilterKit, image: Image): Image {
  const s = kit.ck.MakeSurface(image.width(), image.height())!;
  s.getCanvas().clear(kit.ck.TRANSPARENT);
  s.getCanvas().drawImage(image, 0, 0);
  const out = s.makeImageSnapshot();
  s.dispose();
  return out;
}

/** Edit › Fade: the filtered image over the original at an opacity and blend mode. */
function fadeOver(kit: FilterKit, original: Image, result: Image, opacity: number, blend: Filter["blend"]): Image {
  const { ck } = kit;
  const s = ck.MakeSurface(original.width(), original.height())!;
  const c = s.getCanvas();
  c.clear(ck.TRANSPARENT);
  c.drawImage(original, 0, 0);
  const p = new ck.Paint();
  p.setAlphaf(opacity);
  p.setBlendMode(ck.BlendMode[(BLEND[blend ?? "normal"] ?? "SrcOver") as "SrcOver"]);
  c.drawImage(result, 0, 0, p);
  p.delete();
  original.delete();
  result.delete();
  const out = s.makeImageSnapshot();
  s.dispose();
  return out;
}

/** Straight 8-bit RGBA in and out, for the rank filters. */
function bytes(kit: FilterKit, image: Image, transform: (pixels: Uint8Array, w: number, h: number) => Uint8Array): Image {
  const [w, h] = [image.width(), image.height()];
  const pixels = image.readPixels(0, 0, rgbaInfo(kit.ck, w, h)) as Uint8Array;
  image.delete();
  return kit.ck.MakeImage(rgbaInfo(kit.ck, w, h), transform(pixels, w, h), w * 4)!;
}

/** Mixes two rasters by a per-pixel weight of the second (0..1), given pixel-centre coordinates. */
function mix(a: Raster, b: Raster, weight: (x: number, y: number) => number): Raster {
  const out = blank(a);
  for (let y = 0; y < a.h; y++)
    for (let x = 0; x < a.w; x++) {
      const t = clamp(weight(x + 0.5, y + 0.5), 0, 1);
      const i = (y * a.w + x) * 4;
      for (let c = 0; c < 4; c++) out.d[i + c] = a.d[i + c]! + (b.d[i + c]! - a.d[i + c]!) * t;
    }
  return out;
}

/** A disc blur, at reduced resolution when wide (its reach stays about 12 px). */
const disc = (r: Raster, radius: number) => reduced(r, radius / 12, (s, f) => discBlur(s, radius / f));

// ── Blur ─────────────────────────────────────────────────────────────────────────────────

function average(r: Raster): Raster {
  let [R, G, B, A] = [0, 0, 0, 0];
  for (let i = 0; i < r.d.length; i += 4) {
    R += r.d[i]!;
    G += r.d[i + 1]!;
    B += r.d[i + 2]!;
    A += r.d[i + 3]!;
  }
  const out = blank(r);
  if (A <= 0) return out;
  for (let i = 0; i < r.d.length; i += 4) {
    const a = r.d[i + 3]!;
    out.d.set([(R / A) * a, (G / A) * a, (B / A) * a, a], i);
  }
  return out;
}

function smartBlur(r: Raster, filter: Of<"smart-blur">, k: number): Raster {
  const smooth = guided(r, Math.max(1, filter.radius * k), (filter.threshold / 255) ** 2);
  if (!filter.mode || filter.mode === "normal") return smooth;
  // Edges: where brightness changes by more than the threshold between neighbours.
  const { w, h } = r;
  const { rgb, a } = planes(r);
  const L = luma(rgb, w * h);
  const edge = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const dx = L[y * w + Math.min(w - 1, x + 1)]! - L[i]!;
      const dy = L[Math.min(h - 1, y + 1) * w + x]! - L[i]!;
      edge[i] = len(dx, dy) * 255 > filter.threshold ? 1 : 0;
    }
  if (filter.mode === "edge-only") return fromPlanes(w, h, [edge, edge, edge], a);
  const s = planes(smooth).rgb;
  return fromPlanes(w, h, s.map((p) => p.map((v, i) => (edge[i] ? 1 : v))), a);
}

/** Four blur levels (none, ⅓, ⅔, full) picked per pixel by a 0..1 strength. */
function levels(base: Raster, blurred: Raster[], strength: (x: number, y: number) => number): Raster {
  const all = [base, ...blurred];
  const out = blank(base);
  for (let y = 0; y < base.h; y++)
    for (let x = 0; x < base.w; x++) {
      const t = clamp(strength(x + 0.5, y + 0.5), 0, 1) * 3;
      const lo = Math.min(2, Math.floor(t));
      const f = t - lo;
      const [a, b] = [all[lo]!, all[lo + 1]!];
      const i = (y * base.w + x) * 4;
      for (let c = 0; c < 4; c++) out.d[i + c] = a.d[i + c]! + (b.d[i + c]! - a.d[i + c]!) * f;
    }
  return out;
}

function lensBlur(ctx: Ctx, image: Image, filter: Of<"lens-blur">): Image {
  const { kit, k, box, ox, oy } = ctx;
  const depth = filter.depth ? kit.images.get(filter.depth) : undefined;
  if (filter.depth && !depth) kit.warnings.push(`lens blur: depth map "${filter.depth}" isn't loaded`);
  const base = readRaster(kit.ck, image);
  const R = filter.radius * k;
  if (!depth) return writeRaster(kit.ck, disc(base, R));
  const blurred = [1, 2, 3].map((i) => disc(base, (R * i) / 3));
  // The depth map is stretched over the layer's box, white near and black far. Pixels at the
  // focal depth (by default the nearest) stay sharp; blur grows with distance from it.
  const map = readRaster(kit.ck, depth, false);
  const L = luma(planes(map).rgb, map.w * map.h);
  const focus = filter.focus ?? 1;
  const [bx, by, bw, bh] = [box.x * k - ox, box.y * k - oy, box.w * k, box.h * k];
  return writeRaster(
    kit.ck,
    levels(base, blurred, (x, y) => Math.abs(samplePlane(L, map.w, map.h, ((x - bx) / bw) * map.w, ((y - by) / bh) * map.h) - focus) * 2),
  );
}

function galleryBlur(ctx: Ctx, image: Image, filter: Of<"field-blur"> | Of<"iris-blur"> | Of<"tilt-shift">): Image {
  const { kit, k, box, at } = ctx;
  const max = filter.kind === "field-blur" ? Math.max(0.0001, ...filter.points.map((p) => p.radius)) : filter.radius;
  const blurred = [1, 2, 3].map((i) => soften(kit, image, (max * i) / 3));
  const base = readRaster(kit.ck, image);
  let strength: (x: number, y: number) => number;
  if (filter.kind === "field-blur") {
    // Pins blend by inverse squared distance, as in Blur Gallery's field blur.
    const pins = filter.points.map((p) => ({ at: at(p.at), r: p.radius / max }));
    strength = (x, y) => {
      let [sum, total] = [0, 0];
      for (const p of pins) {
        const wt = 1 / ((x - p.at[0]) ** 2 + (y - p.at[1]) ** 2 + 1);
        sum += p.r * wt;
        total += wt;
      }
      return sum / total;
    };
  } else if (filter.kind === "iris-blur") {
    const [cx, cy] = at(filter.center);
    const [sx, sy] = [((filter.size?.[0] ?? 0.4) * box.w * k) / 2, ((filter.size?.[1] ?? 0.4) * box.h * k) / 2];
    const a = ((filter.angle ?? 0) * Math.PI) / 180;
    const [cs, sn] = [Math.cos(a), Math.sin(a)];
    const feather = filter.feather ?? 0.5;
    strength = (x, y) => {
      const [dx, dy] = [x - cx, y - cy];
      const [u, v] = [(dx * cs + dy * sn) / sx, (-dx * sn + dy * cs) / sy];
      return smoothstep(1 - feather, 1 + feather * 0.5, len(u, v));
    };
  } else {
    const [cx, cy] = at(filter.center);
    const a = ((filter.angle ?? 0) * Math.PI) / 180;
    const band = ((filter.band ?? 0.15) * box.h * k) / 2;
    const transition = (filter.transition ?? 0.2) * box.h * k;
    const [cs, sn] = [Math.cos(a), Math.sin(a)];
    strength = (x, y) => smoothstep(band, band + transition, Math.abs(-(x - cx) * sn + (y - cy) * cs));
  }
  return writeRaster(kit.ck, levels(base, blurred, strength));
}

// ── Distort ──────────────────────────────────────────────────────────────────────────────

function displace(ctx: Ctx, image: Image, filter: Of<"displace">): Image {
  const { kit, k, box, ox, oy } = ctx;
  const mapImage = kit.images.get(filter.map);
  if (!mapImage) {
    kit.warnings.push(`displace: map "${filter.map}" isn't loaded`);
    return image;
  }
  const r = readRaster(kit.ck, image);
  const map = planes(readRaster(kit.ck, mapImage, false));
  const [mw, mh] = [mapImage.width(), mapImage.height()];
  const [bx, by, bw, bh] = [box.x * k - ox, box.y * k - oy, box.w * k, box.h * k];
  const tile = filter.fit === "tile";
  const [sx, sy] = [filter.scale[0] * k, filter.scale[1] * k];
  const where = (x: number, y: number): Pt => {
    if (!tile) return [((x - bx) / bw) * mw, ((y - by) / bh) * mh];
    const [u, v] = [(x - bx) / k, (y - by) / k];
    return [((u % mw) + mw) % mw, ((v % mh) + mh) % mh];
  };
  // 50% grey stays put; black and white move by the scale in opposite directions. Red moves
  // horizontally and green vertically (a grey map moves both).
  return writeRaster(
    kit.ck,
    remap(r, (x, y, to) => {
      const [mx, my] = where(x, y);
      to[0] = x - (samplePlane(map.rgb[0], mw, mh, mx, my) - 0.5) * 2 * sx;
      to[1] = y - (samplePlane(map.rgb[1], mw, mh, mx, my) - 0.5) * 2 * sy;
    }),
  );
}

function pinch(ctx: Ctx, r: Raster, a: number): Raster {
  const [cx, cy] = ctx.at();
  const R = ctx.minSide / 2;
  // Positive amounts pull the circle's content in towards its centre, negative push it out.
  const e = 1 - a * 0.5;
  return remap(r, (x, y, to) => {
    const [dx, dy] = [x - cx, y - cy];
    const t = len(dx, dy) / R;
    if (t >= 1 || t === 0) return;
    const s = t ** e / t;
    to[0] = cx + dx * s;
    to[1] = cy + dy * s;
  });
}

function spherize(ctx: Ctx, r: Raster, filter: Of<"spherize">): Raster {
  const [cx, cy] = ctx.at();
  const [Rx, Ry] = [(ctx.box.w * ctx.k) / 2, (ctx.box.h * ctx.k) / 2];
  const [ax, ay] = filter.mode === "horizontal" ? [1, 0] : filter.mode === "vertical" ? [0, 1] : [1, 1];
  const a = filter.amount / 100;
  return remap(r, (x, y, to) => {
    const [dx, dy] = [(x - cx) / Rx, (y - cy) / Ry];
    const l = len(dx * ax, dy * ay);
    if (l >= 1 || l === 0) return;
    // Positive bulges the centre out like a sphere; negative pinches it in.
    const n = a > 0 ? l + (1 - Math.cos((l * Math.PI) / 2) - l) * a : l + (Math.sin((l * Math.PI) / 2) - l) * -a;
    const s = n / l;
    to[0] = cx + (ax ? dx * s : dx) * Rx;
    to[1] = cy + (ay ? dy * s : dy) * Ry;
  });
}

function polar(r: Raster, toPolar: boolean): Raster {
  const { w, h } = r;
  const [cx, cy] = [w / 2, h / 2];
  const Rm = Math.min(w, h) / 2;
  return remap(r, (x, y, to) => {
    if (toPolar) {
      // The top edge gathers at the centre; the left and right edges meet at 12 o'clock.
      const [dx, dy] = [x - cx, y - cy];
      to[0] = ((Math.atan2(dx, -dy) + Math.PI) / (2 * Math.PI)) * w;
      to[1] = (len(dx, dy) / Rm) * h;
    } else {
      const th = (x / w) * 2 * Math.PI - Math.PI;
      const rr = (y / h) * Rm;
      to[0] = cx + Math.sin(th) * rr;
      to[1] = cy - Math.cos(th) * rr;
    }
  });
}

function ripple(ctx: Ctx, r: Raster, filter: Of<"ripple">): Raster {
  const { k, ox, oy } = ctx;
  const len = { small: 10, medium: 20, large: 40 }[filter.size ?? "medium"] * k;
  const amp = (filter.amount / 100) * 1.5 * k;
  return remap(r, (x, y, to) => {
    const [gx, gy] = [x + ox, y + oy];
    to[0] = x + Math.sin((gy / len) * 2 * Math.PI + valueNoise(gx / (len * 3), gy / (len * 3), 5) * 4) * amp;
    to[1] = y + Math.sin((gx / len) * 2 * Math.PI + valueNoise(gy / (len * 3), gx / (len * 3), 9) * 4) * amp;
  });
}

function zigzag(ctx: Ctx, r: Raster, filter: Of<"zigzag">): Raster {
  const [cx, cy] = ctx.at();
  const R = ctx.minSide / 2;
  const amp = (filter.amount / 100) * R * 0.15;
  const style = filter.style ?? "pond-ripples";
  return remap(r, (x, y, to) => {
    const [dx, dy] = [x - cx, y - cy];
    const l = len(dx, dy);
    if (l >= R || l === 0) return;
    const wv = Math.sin((l / R) * filter.ridges * 2 * Math.PI) * amp * (1 - l / R);
    if (style === "around-center") {
      const a = (wv / R) * 3;
      to[0] = cx + dx * Math.cos(a) - dy * Math.sin(a);
      to[1] = cy + dx * Math.sin(a) + dy * Math.cos(a);
    } else if (style === "out-from-center") {
      to[0] = x + (dx / l) * wv;
      to[1] = y + (dy / l) * wv;
    } else {
      to[0] = x + ((dx - dy) / l) * wv * 0.5;
      to[1] = y + ((dy + dx) / l) * wv * 0.5;
    }
  });
}

function ocean(ctx: Ctx, r: Raster, filter: Of<"ocean-ripple">): Raster {
  const { k, ox, oy } = ctx;
  const size = filter.size * 4 * k;
  const mag = filter.magnitude * 0.8 * k;
  // Ripples follow the slope of a noise height field: smooth bumps, like light through water.
  const n = (p: number, q: number) => valueNoise(p, q, 11) + valueNoise(p * 2.1, q * 2.1, 12) * 0.5;
  return remap(r, (x, y, to) => {
    const [u, v] = [(x + ox) / size, (y + oy) / size];
    to[0] = x + (n(u + 0.1, v) - n(u - 0.1, v)) * mag * 3;
    to[1] = y + (n(u, v + 0.1) - n(u, v - 0.1)) * mag * 3;
  });
}

function diffuseGlow(ctx: Ctx, r: Raster, filter: Of<"diffuse-glow">): Raster {
  const { k, ox, oy } = ctx;
  const glow = filter.glow / 20;
  const grain = filter.graininess / 20;
  const clear = 1 - filter.clear / 20;
  const w = r.w;
  // Bright areas bloom towards white, with grain in the glow.
  return mapColor(r, (c, i) => {
    const l = c[0]! * 0.299 + c[1]! * 0.587 + c[2]! * 0.114;
    const g = smoothstep(clear, 1, l) * glow;
    const n = (hash(Math.floor(((i % w) + ox) / Math.max(1, k)), Math.floor((Math.floor(i / w) + oy) / Math.max(1, k)), 3) - 0.5) * grain * smoothstep(0.3, 1, l);
    for (let j = 0; j < 3; j++) c[j] = c[j]! + g + n;
  });
}

/** Resamples by a displacement field computed on a coarse grid (a quarter of the size), interpolated. */
function warpField(r: Raster, build: (fw: number, fh: number, sx: number, sy: number) => { dx: Float32Array; dy: Float32Array }): Raster {
  const [fw, fh] = [Math.max(2, Math.ceil(r.w / 4)), Math.max(2, Math.ceil(r.h / 4))];
  const [sx, sy] = [r.w / fw, r.h / fh];
  const { dx, dy } = build(fw, fh, sx, sy);
  return remap(r, (x, y, to) => {
    to[0] = x + samplePlane(dx, fw, fh, x / sx, y / sy);
    to[1] = y + samplePlane(dy, fw, fh, x / sx, y / sy);
  });
}

/** Liquify strokes as a field of where each output point samples from; each op applies to the result of the last. */
function liquifyField(ctx: Ctx, filter: Of<"liquify">, fw: number, fh: number, sx: number, sy: number) {
  const dx = new Float32Array(fw * fh);
  const dy = new Float32Array(fw * fh);
  for (const op of filter.ops) {
    const [cx, cy] = ctx.at(op.at);
    const R = op.radius * ctx.minSide;
    const s = op.strength ?? 0.6;
    const [tx, ty] = op.to ? ctx.at(op.to) : [cx, cy];
    for (let j = 0; j < fh; j++)
      for (let i = 0; i < fw; i++) {
        const n = j * fw + i;
        const [px, py] = [(i + 0.5) * sx, (j + 0.5) * sy];
        // Forward warp carries the brush's content to its end point, so the falloff centres there.
        const [ccx, ccy] = op.tool === "forward-warp" ? [tx, ty] : [cx, cy];
        const d = len(px - ccx, py - ccy);
        if (d >= R) continue;
        const fall = (1 - (d / R) ** 2) ** 2 * s;
        let [ox, oy] = [0, 0];
        if (op.tool === "forward-warp") [ox, oy] = [-(tx - cx) * fall, -(ty - cy) * fall];
        else if (op.tool === "pucker") [ox, oy] = [(px - cx) * fall * 0.5, (py - cy) * fall * 0.5];
        else if (op.tool === "bloat") [ox, oy] = [-(px - cx) * fall * 0.5, -(py - cy) * fall * 0.5];
        else if (op.tool === "push-left") {
          const [ux, uy] = [tx - cx, ty - cy];
          [ox, oy] = [uy * fall * 0.5, -ux * fall * 0.5];
        } else {
          const a = (op.tool === "twirl-clockwise" ? -1 : 1) * fall * 1.5;
          const [rx, ry] = [px - cx, py - cy];
          [ox, oy] = [rx * Math.cos(a) - ry * Math.sin(a) - rx, rx * Math.sin(a) + ry * Math.cos(a) - ry];
        }
        dx[n]! += ox;
        dy[n]! += oy;
      }
  }
  return { dx, dy };
}

/**
 * Puppet Warp as rigid moving-least-squares: each output point takes the rotation and shift that
 * best map the pins' new positions back to their old ones, weighted by distance.
 */
function puppetField(ctx: Ctx, filter: Of<"puppet-warp">, fw: number, fh: number, sx: number, sy: number) {
  const pins = filter.pins.map((pin) => ({ p: ctx.at(pin.to), q: ctx.at(pin.from) }));
  const alpha = 1 + (filter.rigidity ?? 0.5);
  const dx = new Float32Array(fw * fh);
  const dy = new Float32Array(fw * fh);
  const wts = new Float64Array(pins.length);
  for (let j = 0; j < fh; j++)
    for (let i = 0; i < fw; i++) {
      const [vx, vy] = [(i + 0.5) * sx, (j + 0.5) * sy];
      let [W, psx, psy, qsx, qsy] = [0, 0, 0, 0, 0];
      pins.forEach(({ p, q }, n) => {
        const wt = 1 / ((p[0] - vx) ** 2 + (p[1] - vy) ** 2 + 1e-3) ** alpha;
        wts[n] = wt;
        W += wt;
        psx += p[0] * wt;
        psy += p[1] * wt;
        qsx += q[0] * wt;
        qsy += q[1] * wt;
      });
      [psx, psy, qsx, qsy] = [psx / W, psy / W, qsx / W, qsy / W];
      let [a11, a12] = [0, 0];
      pins.forEach(({ p, q }, n) => {
        const [phx, phy, qhx, qhy] = [p[0] - psx, p[1] - psy, q[0] - qsx, q[1] - qsy];
        a11 += wts[n]! * (phx * qhx + phy * qhy);
        a12 += wts[n]! * (phx * qhy - phy * qhx);
      });
      const norm = len(a11, a12);
      const [c, s] = pins.length > 1 && norm > 0 ? [a11 / norm, a12 / norm] : [1, 0];
      const [rx, ry] = [vx - psx, vy - psy];
      dx[j * fw + i] = c * rx - s * ry + qsx - vx;
      dy[j * fw + i] = s * rx + c * ry + qsy - vy;
    }
  return { dx, dy };
}

function lensCorrection(ctx: Ctx, r: Raster, filter: Of<"lens-correction">): Raster {
  const [cx, cy] = ctx.at();
  const R = len(ctx.box.w, ctx.box.h) * ctx.k * 0.5;
  // Positive distortion removes barrel distortion (pulls the edges in); negative removes pincushion.
  const kk = -((filter.distortion ?? 0) / 100) * 0.5;
  const ca = ((filter.redCyan ?? 0) / 100) * 0.01;
  const cb = ((filter.blueYellow ?? 0) / 100) * 0.01;
  const vig = (filter.vignette ?? 0) / 100;
  const mid = (filter.vignetteMidpoint ?? 50) / 100;
  const out = blank(r);
  const tmp = new Float32Array(4);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const [dx, dy] = [(x + 0.5 - cx) / R, (y + 0.5 - cy) / R];
      const r2 = dx * dx + dy * dy;
      const s = 1 + kk * r2;
      const o = (y * r.w + x) * 4;
      sample(r, cx + dx * s * R, cy + dy * s * R, out.d, o);
      // Chromatic aberration: red and blue land at slightly different radii.
      sample(r, cx + dx * s * (1 + ca) * R, cy + dy * s * (1 + ca) * R, tmp, 0);
      out.d[o] = tmp[0]!;
      sample(r, cx + dx * s * (1 + cb) * R, cy + dy * s * (1 + cb) * R, tmp, 0);
      out.d[o + 2] = tmp[2]!;
      const v = 1 + vig * smoothstep(mid * 0.7, 1.1, Math.sqrt(r2));
      for (let c = 0; c < 3; c++) out.d[o + c] = Math.min(out.d[o + 3]!, out.d[o + c]! * v);
    }
  return out;
}

// ── Noise ────────────────────────────────────────────────────────────────────────────────

function despeckle(px: Uint8Array, w: number, h: number, r: number): Uint8Array {
  // A small median, kept off strong edges so outlines stay crisp.
  const med = median(px, w, h, r);
  const out = new Uint8Array(px);
  for (let i = 0; i < px.length; i += 4) {
    const n = i / 4;
    const right = (n % w) + 1 < w ? i + 4 : i;
    const down = Math.floor(n / w) + 1 < h ? i + w * 4 : i;
    let edge = 0;
    for (let c = 0; c < 3; c++) edge += Math.abs(px[i + c]! - px[right + c]!) + Math.abs(px[i + c]! - px[down + c]!);
    if (edge < 90) out.set(med.subarray(i, i + 3), i);
  }
  return out;
}

function dust(px: Uint8Array, w: number, h: number, r: number, threshold: number): Uint8Array {
  // Only pixels that differ from the neighbourhood median by more than the threshold change.
  const med = median(px, w, h, r);
  const out = new Uint8Array(px);
  for (let i = 0; i < px.length; i += 4) {
    const d = Math.max(Math.abs(px[i]! - med[i]!), Math.abs(px[i + 1]! - med[i + 1]!), Math.abs(px[i + 2]! - med[i + 2]!));
    if (d > threshold) out.set(med.subarray(i, i + 3), i);
  }
  return out;
}

// ── Pixelate ─────────────────────────────────────────────────────────────────────────────

function colorHalftone(ctx: Ctx, r: Raster, filter: Of<"color-halftone">): Raster {
  const { k, ox, oy } = ctx;
  const cell = filter.radius * 2 * k;
  const angles = (filter.angles ?? [108, 162, 90, 45]).map((d) => (d * Math.PI) / 180);
  const trig = angles.map((a) => [Math.cos(a), Math.sin(a)] as Pt);
  const out = blank(r);
  const tmp = new Float32Array(4);
  // Cyan, magenta, yellow and black are each screened at their own angle; a dot's area follows its ink.
  const ink = (gx: number, gy: number, ch: number) => {
    const [cs, sn] = trig[ch]!;
    const [u, v] = [gx * cs + gy * sn, -gx * sn + gy * cs];
    const [cu, cv] = [(Math.floor(u / cell) + 0.5) * cell, (Math.floor(v / cell) + 0.5) * cell];
    sample(r, cu * cs - cv * sn - ox, cu * sn + cv * cs - oy, tmp, 0);
    const al = tmp[3]! || 1;
    const [R, G, B] = [tmp[0]! / al, tmp[1]! / al, tmp[2]! / al];
    const K = 1 - Math.max(R, G, B);
    const value = ch === 3 ? K : (1 - (ch === 0 ? R : ch === 1 ? G : B) - K) / Math.max(1 - K, 0.001);
    const radius = Math.sqrt(clamp(value, 0, 1)) * cell * 0.7071;
    return clamp(radius - len(u - cu, v - cv) + 0.5, 0, 1);
  };
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const [gx, gy] = [x + 0.5 + ox, y + 0.5 + oy];
      const [c, m, yy, kk] = [ink(gx, gy, 0), ink(gx, gy, 1), ink(gx, gy, 2), ink(gx, gy, 3)];
      const o = (y * r.w + x) * 4;
      const a = r.d[o + 3]!;
      out.d[o] = (1 - c) * (1 - kk) * a;
      out.d[o + 1] = (1 - m) * (1 - kk) * a;
      out.d[o + 2] = (1 - yy) * (1 - kk) * a;
      out.d[o + 3] = a;
    }
  return out;
}

/** Crystallize (cells take their seed's colour) or, with a background, Pointillize (dots on it). */
function cells(ctx: Ctx, r: Raster, size: number, background: [number, number, number] | undefined): Raster {
  const { ox, oy } = ctx;
  const out = blank(r);
  // Seeds sit at a random point in each grid cell (of the artboard); each cell's colour is sampled once.
  const [cx0, cy0] = [Math.floor(ox / size) - 1, Math.floor(oy / size) - 1];
  const [cw, chh] = [Math.ceil((ox + r.w) / size) + 2 - cx0, Math.ceil((oy + r.h) / size) + 2 - cy0];
  const seeds = new Float64Array(cw * chh * 2);
  const colors = new Float32Array(cw * chh * 3);
  const tmp = new Float32Array(4);
  for (let j = 0; j < chh; j++)
    for (let i = 0; i < cw; i++) {
      const [gx, gy] = [cx0 + i, cy0 + j];
      const n = j * cw + i;
      seeds[n * 2] = gx + hash(gx, gy, 1);
      seeds[n * 2 + 1] = gy + hash(gx, gy, 2);
      sample(r, seeds[n * 2]! * size - ox, seeds[n * 2 + 1]! * size - oy, tmp, 0);
      const al = tmp[3]! || 1;
      for (let c = 0; c < 3; c++) colors[n * 3 + c] = tmp[c]! / al;
    }
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const [qx, qy] = [(x + 0.5 + ox) / size, (y + 0.5 + oy) / size];
      const [bx, by] = [Math.floor(qx) - cx0, Math.floor(qy) - cy0];
      let [best, pick] = [Infinity, 0];
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const n = (by + j) * cw + bx + i;
          const [dx, dy] = [qx - seeds[n * 2]!, qy - seeds[n * 2 + 1]!];
          const d = dx * dx + dy * dy;
          if (d < best) [best, pick] = [d, n];
        }
      const o = (y * r.w + x) * 4;
      const a = r.d[o + 3]!;
      const dot = background ? clamp((0.42 - Math.sqrt(best)) * size + 0.5, 0, 1) : 1;
      for (let c = 0; c < 3; c++) out.d[o + c] = (colors[pick * 3 + c]! * dot + (background ? background[c]! * (1 - dot) : 0)) * a;
      out.d[o + 3] = a;
    }
  return out;
}

function fragment(r: Raster, d: number): Raster {
  // Four copies offset diagonally, averaged: a jittery double-vision look.
  const out = blank(r);
  const tmp = new Float32Array(4);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const o = (y * r.w + x) * 4;
      for (const [dx, dy] of [[d, d], [-d, d], [d, -d], [-d, -d]] as const) {
        sample(r, x + 0.5 + dx, y + 0.5 + dy, tmp, 0);
        for (let c = 0; c < 4; c++) out.d[o + c]! += tmp[c]! / 4;
      }
    }
  return out;
}

function mezzotint(ctx: Ctx, r: Raster, filter: Of<"mezzotint">): Raster {
  const { k, ox, oy } = ctx;
  const t = filter.type ?? "medium-dots";
  const grain = (t.startsWith("fine") ? 1 : t.startsWith("medium") ? 2 : t.startsWith("grainy") ? 1.5 : 3) * Math.max(1, k);
  const len = t.endsWith("lines") || t.endsWith("strokes") ? (t.startsWith("short") ? 4 : t.startsWith("medium") ? 10 : 24) : 1;
  const w = r.w;
  // Every channel becomes fully on or off against a random threshold per dot, line or stroke.
  return mapColor(r, (c, i) => {
    const [gx, gy] = [Math.floor(((i % w) + ox) / (grain * len)), Math.floor((Math.floor(i / w) + oy) / grain)];
    for (let j = 0; j < 3; j++) c[j] = c[j]! > hash(gx, gy, 20 + j) ? 1 : 0;
  });
}

// ── Render ───────────────────────────────────────────────────────────────────────────────

function clouds(ctx: Ctx, r: Raster, filter: Of<"clouds"> | Of<"difference-clouds"> | Of<"fibers">): Raster {
  const { k, ox, oy } = ctx;
  const [c0, c1] = filter.kind !== "difference-clouds" && filter.colors ? [rgb01(filter.colors[0]), rgb01(filter.colors[1])] : [[0, 0, 0], [1, 1, 1]];
  const seed = (filter.seed ?? 7) * 101;
  const w = r.w;
  let value: (gx: number, gy: number) => number;
  if (filter.kind === "fibers") {
    // Noise stretched vertically: variance sets how often colours change across, strength how long the strands run.
    const sx = (4 + 64 / filter.variance) * k;
    const sy = sx * filter.strength * 2;
    value = (gx, gy) => clamp((fbm(gx / sx, gy / sy, 4, seed) - 0.5) * 1.8 + 0.5, 0, 1);
  } else {
    const scale = (filter.scale ?? 160) * k;
    const detail = filter.kind === "clouds" ? (filter.detail ?? 6) : 6;
    // Octaves finer than a pixel add nothing.
    const octaves = Math.max(1, Math.min(detail, Math.ceil(Math.log2(Math.max(2, scale)))));
    value = (gx, gy) => clamp((fbm(gx / scale, gy / scale, octaves, seed) - 0.5) * 1.6 + 0.5, 0, 1);
  }
  return mapColor(r, (c, i) => {
    const n = value((i % w) + ox + 0.5, Math.floor(i / w) + oy + 0.5);
    for (let j = 0; j < 3; j++) {
      const col = c0[j]! + (c1[j]! - c0[j]!) * n;
      c[j] = filter.kind === "difference-clouds" ? Math.abs(c[j]! - col) : col;
    }
  });
}

function lensFlare(ctx: Ctx, r: Raster, filter: Of<"lens-flare">): Raster {
  const [fx, fy] = ctx.at(filter.at);
  const [cx, cy] = ctx.at();
  const size = Math.max(r.w, r.h) * 0.35;
  const b = (filter.brightness ?? 100) / 100;
  const lens = filter.lens ?? "50-300mm";
  const streak = lens === "movie-prime" ? 1 : lens === "105mm" ? 0.15 : 0.3;
  const ghosts = lens === "35mm" ? 6 : 4;
  const w = r.w;
  // A hot core and halo, a faint ring, a horizontal streak, and ghost discs along the line through the centre.
  return mapColor(r, (c, i) => {
    const [px, py] = [(i % w) + 0.5, Math.floor(i / w) + 0.5];
    const d = len(px - fx, py - fy) / size;
    const ring = Math.exp(-(((d - 0.55) * 14) ** 2)) * 0.25;
    const core = Math.exp(-d * d * 6) * 1.2 + Math.exp(-d * 2.5) * 0.25 + Math.exp(-Math.abs(py - fy) / (size * 0.012)) * Math.exp(-Math.abs(px - fx) / (size * 0.8)) * 0.6 * streak;
    const add = [core + ring * 0.6, core * 0.95 + ring * 0.8, core * 0.85 + ring];
    for (let g = 1; g <= ghosts; g++) {
      const t = g * 0.35;
      const [gx, gy] = [fx + (cx - fx) * (1 + t), fy + (cy - fy) * (1 + t)];
      const v = smoothstep(1, 0.7, len(px - gx, py - gy) / (size * (0.05 + 0.04 * g))) * 0.12;
      add[0]! += v * (0.4 + 0.15 * g);
      add[1]! += v * 0.6;
      add[2]! += v * (1 - 0.12 * g);
    }
    for (let j = 0; j < 3; j++) c[j] = c[j]! + (1 - c[j]!) * clamp(add[j]! * b, 0, 1);
  });
}

function lighting(ctx: Ctx, r: Raster, filter: Of<"lighting-effects">): Raster {
  const { w, h } = r;
  const span = Math.max(ctx.box.w, ctx.box.h) * ctx.k;
  const { rgb, a } = planes(r);
  const L = luma(rgb, w * h);
  const height = (filter.height ?? 0) / 10;
  const ambient = filter.ambient ?? 0.35;
  const lights = filter.lights.map((l) => {
    const ang = ((l.angle ?? 225) * Math.PI) / 180;
    return { type: l.type, at: ctx.at(l.at), dir: [Math.cos(ang), -Math.sin(ang)] as Pt, color: rgb01(l.color ?? "#FFFFFF"), intensity: l.intensity ?? 1, radius: (l.radius ?? 0.6) * span };
  });
  const out: Float32Array[] = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
  const light = [0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // The image's brightness is a height map (Photoshop's texture channel): bumps catch the light.
      const hx = L[y * w + Math.min(w - 1, x + 1)]! - L[y * w + Math.max(0, x - 1)]!;
      const hy = L[Math.min(h - 1, y + 1) * w + x]! - L[Math.max(0, y - 1) * w + x]!;
      let [nx, ny, nz] = [-hx * height, -hy * height, 1];
      const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
      [nx, ny, nz] = [nx / nl, ny / nl, nz / nl];
      light[0] = light[1] = light[2] = ambient;
      for (const l of lights) {
        let [lx, ly, lz] = [l.dir[0], l.dir[1], 0.6];
        let fall = 1;
        if (l.type !== "infinite") {
          const [vx, vy] = [l.at[0] - (x + 0.5), l.at[1] - (y + 0.5)];
          const dist = len(vx, vy);
          [lx, ly, lz] = [vx, vy, l.radius * 0.25];
          fall = clamp(1 - dist / l.radius, 0, 1);
          // A spot shines along its angle from where it sits.
          if (l.type === "spot") fall *= smoothstep(0.6, 0.95, dist > 0 ? (-vx * l.dir[0] - vy * l.dir[1]) / dist : 1);
        }
        const ll = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
        const lambert = (Math.max(0, (nx * lx + ny * ly + nz * lz) / ll) * fall * l.intensity);
        for (let c = 0; c < 3; c++) light[c]! += l.color[c]! * lambert;
      }
      for (let c = 0; c < 3; c++) out[c]![i] = rgb[c]![i]! * light[c]!;
    }
  return fromPlanes(w, h, out, a);
}

// ── Sharpen ──────────────────────────────────────────────────────────────────────────────

/** A Gaussian-blurred copy of the image (kept), as a raster: on the CPU up to sigma 12, where Skia's blur is slower. */
function soften(kit: FilterKit, image: Image, radius: number): Raster {
  const sigma = radius * kit.scale;
  return sigma < 12 ? gaussBlur(readRaster(kit.ck, image, false), sigma) : readRaster(kit.ck, kit.blur(image, radius, true));
}

/** Unsharp mask: pushes each pixel away from its softened copy, skipping differences under the threshold (levels). */
function unsharp(r: Raster, soft: Raster, amount: number, threshold: number): Raster {
  const out = blank(r);
  const { d } = r;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]!;
    out.d[i + 3] = a;
    const [d0, d1, d2] = [d[i]! - soft.d[i]!, d[i + 1]! - soft.d[i + 1]!, d[i + 2]! - soft.d[i + 2]!];
    const keep = threshold > 0 && (Math.abs(d0 * 0.299 + d1 * 0.587 + d2 * 0.114) / Math.max(a, 0.001)) * 255 < threshold;
    const k = keep ? 0 : amount;
    out.d[i] = d[i]! + d0 * k;
    out.d[i + 1] = d[i + 1]! + d1 * k;
    out.d[i + 2] = d[i + 2]! + d2 * k;
  }
  return out;
}

function motionCopy(kit: FilterKit, image: Image, angle: number, distance: number): Image {
  const a = (angle * Math.PI) / 180;
  const d = distance * kit.scale;
  return kit.runShader(copy(kit, image), 1, (child) => ({ shader: shaderEffect(kit.ck, "motion").makeShaderWithChildren([Math.cos(a) * d, -Math.sin(a) * d], [child]) }));
}

function highPass(r: Raster, soft: Raster, scale: number): Raster {
  // Detail only, around 50% grey: blend it in Overlay or Soft Light to sharpen.
  const s = planes(soft).rgb;
  return mapColor(r, (c, i) => {
    for (let j = 0; j < 3; j++) c[j] = (c[j]! - s[j]![i]!) * scale + 0.5;
  });
}

// ── Stylize ──────────────────────────────────────────────────────────────────────────────

function diffuse(ctx: Ctx, r: Raster, mode: NonNullable<Of<"diffuse">["mode"]>): Raster {
  const { k, ox, oy } = ctx;
  const out = blank(r);
  const unit = Math.max(1, k);
  const reach = 2 * unit;
  const lum = (i: number) => (r.d[i]! * 0.299 + r.d[i + 1]! * 0.587 + r.d[i + 2]! * 0.114) / (r.d[i + 3]! || 1);
  // Each pixel shows a random nearby one; darken/lighten only take darker/lighter ones; anisotropic shuffles along rows.
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const [gx, gy] = [Math.floor((x + ox) / unit), Math.floor((y + oy) / unit)];
      const dx = Math.round((hash(gx, gy, 31) * 2 - 1) * reach * (mode === "anisotropic" ? 1.5 : 1));
      const dy = mode === "anisotropic" ? 0 : Math.round((hash(gx, gy, 32) * 2 - 1) * reach);
      const o = (y * r.w + x) * 4;
      const s = (clamp(y + dy, 0, r.h - 1) * r.w + clamp(x + dx, 0, r.w - 1)) * 4;
      const take = mode === "darken-only" ? lum(s) < lum(o) : mode === "lighten-only" ? lum(s) > lum(o) : true;
      const from = take ? s : o;
      for (let c = 0; c < 4; c++) out.d[o + c] = r.d[from + c]!;
    }
  return out;
}

function emboss(ctx: Ctx, r: Raster, filter: Of<"emboss">): Raster {
  const { w, h } = r;
  const a = ((filter.angle ?? 135) * Math.PI) / 180;
  const d = (filter.height ?? 3) * ctx.k;
  const [dx, dy] = [Math.cos(a) * d, -Math.sin(a) * d];
  const amount = ((filter.amount ?? 100) / 100) * 2;
  const { rgb, a: alpha } = planes(r);
  const L = luma(rgb, w * h);
  // Relief in grey: lighter where the surface faces the light.
  const v = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) v[y * w + x] = 0.5 + (samplePlane(L, w, h, x + 0.5 + dx, y + 0.5 + dy) - samplePlane(L, w, h, x + 0.5 - dx, y + 0.5 - dy)) * amount;
  return fromPlanes(w, h, [v, v, v], alpha);
}

function extrude(ctx: Ctx, r: Raster, filter: Of<"extrude">): Raster {
  // Blocks of the colour at their centre, bevelled on two sides; the bevel is wider where brighter.
  const { k, ox, oy } = ctx;
  const size = filter.size * k;
  const tmp = new Float32Array(4);
  const depth = clamp(filter.depth / 255, 0, 1);
  const w = r.w;
  return mapColor(r, (c, i) => {
    const [gx, gy] = [(i % w) + 0.5 + ox, Math.floor(i / w) + 0.5 + oy];
    const [cx, cy] = [Math.floor(gx / size), Math.floor(gy / size)];
    sample(r, (cx + 0.5) * size - ox, (cy + 0.5) * size - oy, tmp, 0);
    const al = tmp[3]! || 1;
    const col = [tmp[0]! / al, tmp[1]! / al, tmp[2]! / al];
    const [lx, ly] = [gx / size - cx - 0.5, gy / size - cy - 0.5];
    const lum = col[0]! * 0.299 + col[1]! * 0.587 + col[2]! * 0.114;
    const bevel = 0.5 - depth * lum * 0.35;
    const shade = Math.max(Math.abs(lx), Math.abs(ly)) > bevel ? (lx + ly < 0 ? 0.22 : -0.22) : 0;
    for (let j = 0; j < 3; j++) c[j] = col[j]! + shade;
  });
}

/** Sobel edges per channel: Find Edges draws them dark on white, Glowing Edges bright on black. */
function edges(r: Raster, width: number, glow: boolean, bright: number): Raster {
  const { w, h } = r;
  const { rgb, a } = planes(r);
  const s = Math.max(1, Math.round(width));
  const out = rgb.map((p) => {
    const e = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const [up, mid, down] = [Math.max(0, y - s) * w, y * w, Math.min(h - 1, y + s) * w];
      for (let x = 0; x < w; x++) {
        const [l, rr] = [Math.max(0, x - s), Math.min(w - 1, x + s)];
        const gx = p[up + rr]! + 2 * p[mid + rr]! + p[down + rr]! - p[up + l]! - 2 * p[mid + l]! - p[down + l]!;
        const gy = p[down + l]! + 2 * p[down + x]! + p[down + rr]! - p[up + l]! - 2 * p[up + x]! - p[up + rr]!;
        const m = Math.min(1, Math.sqrt(gx * gx + gy * gy) * 0.5);
        e[mid + x] = glow ? m * bright : 1 - m;
      }
    }
    return e;
  });
  return fromPlanes(w, h, out, a);
}

function oilPaint(ctx: Ctx, r: Raster, filter: Of<"oil-paint">): Raster {
  const k = ctx.k;
  // Cleanliness smooths before painting; shine lights the strokes from the given angle.
  const base = (filter.cleanliness ?? 0) > 0 ? guided(r, (filter.cleanliness ?? 0) * 0.6 * k, 0.003) : r;
  const painted = kuwahara(base, filter.stylization * 1.5 * k);
  const shine = (filter.shine ?? 1) / 10;
  if (shine <= 0) return painted;
  const { w, h } = painted;
  const { rgb, a } = planes(painted);
  const L = luma(rgb, w * h);
  const ang = ((filter.angle ?? 135) * Math.PI) / 180;
  const [dx, dy] = [Math.cos(ang) * 2 * k, -Math.sin(ang) * 2 * k];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const g = samplePlane(L, w, h, x + 0.5 + dx, y + 0.5 + dy) - samplePlane(L, w, h, x + 0.5 - dx, y + 0.5 - dy);
      for (let c = 0; c < 3; c++) rgb[c]![y * w + x]! += g * shine * 2;
    }
  return fromPlanes(w, h, rgb, a);
}

function tiles(ctx: Ctx, r: Raster, filter: Of<"tiles">): Raster {
  const { ox, oy } = ctx;
  const size = ctx.minSide / filter.count;
  const off = ((filter.offset ?? 10) / 100) * size;
  // Each tile shifts by a random amount; the gaps show the image unchanged.
  return remap(r, (x, y, to) => {
    const [gx, gy] = [x + ox, y + oy];
    const [cx, cy] = [Math.floor(gx / size), Math.floor(gy / size)];
    const [dx, dy] = [(hash(cx, cy, 41) - 0.5) * 2 * off, (hash(cx, cy, 42) - 0.5) * 2 * off];
    const [lx, ly] = [gx - cx * size - dx, gy - cy * size - dy];
    if (lx < 0 || ly < 0 || lx > size || ly > size) return;
    to[0] = cx * size + lx - ox;
    to[1] = cy * size + ly - oy;
  });
}

function traceContour(r: Raster, level: number, upper: boolean): Raster {
  const { w, h } = r;
  const { rgb, a } = planes(r);
  // Thin lines where each channel crosses the level, on the chosen side, over white.
  const out = rgb.map((p) => {
    const o = new Float32Array(w * h).fill(1);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = p[y * w + x]!;
        const right = p[y * w + Math.min(w - 1, x + 1)]!;
        const down = p[Math.min(h - 1, y + 1) * w + x]!;
        const crosses = v >= level !== right >= level || v >= level !== down >= level;
        if (crosses && (upper ? v >= level : v < level)) o[y * w + x] = 0;
      }
    return o;
  });
  return fromPlanes(w, h, out, a);
}

function wind(ctx: Ctx, r: Raster, filter: Of<"wind">): Raster {
  const { w, h } = r;
  const len = (filter.method === "blast" ? 40 : 14) * ctx.k;
  const toRight = filter.direction !== "left";
  const { rgb, a } = planes(r);
  const out = rgb.map((p) => p.slice());
  // Bright pixels streak downwind, fading over the length; Stagger varies the streaks row by row.
  for (let y = 0; y < h; y++) {
    const rowLen = filter.method === "stagger" ? len * (0.3 + hash(0, Math.floor((y + ctx.oy) / Math.max(1, ctx.k)), 51) * 1.4) : len;
    const decay = Math.exp(-1 / Math.max(1, rowLen));
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let n = 0; n < w; n++) {
        const i = y * w + (toRight ? n : w - 1 - n);
        acc = Math.max(rgb[c]![i]!, acc * decay);
        out[c]![i] = acc;
      }
    }
  }
  return fromPlanes(w, h, out, a);
}

function posterize(r: Raster, levels: number): Raster {
  const n = Math.max(2, levels) - 1;
  return mapColor(r, (c) => {
    for (let j = 0; j < 3; j++) c[j] = Math.round(c[j]! * n) / n;
  });
}

function posterEdges(r: Raster, filter: Of<"poster-edges">, k: number): Raster {
  const { w, h } = r;
  const poster = planes(posterize(r, (filter.posterization ?? 2) + 2));
  const L = luma(planes(r).rgb, w * h);
  const thick = Math.max(1, ((filter.thickness ?? 2) / 2) * k);
  const strength = ((filter.intensity ?? 1) + 1) * 1.5;
  // Strong edges are inked black over the posterized colours.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const e =
        Math.abs(samplePlane(L, w, h, x + 0.5 + thick, y + 0.5) - samplePlane(L, w, h, x + 0.5 - thick, y + 0.5)) +
        Math.abs(samplePlane(L, w, h, x + 0.5, y + 0.5 + thick) - samplePlane(L, w, h, x + 0.5, y + 0.5 - thick));
      const ink = 1 - clamp(e * strength, 0, 0.9);
      for (let c = 0; c < 3; c++) poster.rgb[c]![y * w + x]! *= ink;
    }
  return fromPlanes(w, h, poster.rgb, poster.a);
}

function halftonePattern(ctx: Ctx, r: Raster, filter: Of<"halftone-pattern">): Raster {
  const { k, ox, oy } = ctx;
  const size = filter.size * 2 * k;
  const contrast = 1 + (filter.contrast ?? 5) / 5;
  const type = filter.type ?? "dot";
  const w = r.w;
  // Greyscale screened by a repeating pattern: concentric circles, dots or lines.
  return mapColor(r, (c, i) => {
    const l = c[0]! * 0.299 + c[1]! * 0.587 + c[2]! * 0.114;
    const [gx, gy] = [(i % w) + 0.5 + ox, Math.floor(i / w) + 0.5 + oy];
    let v: number;
    if (type === "circle") {
      const big = size * 12;
      v = 0.5 + 0.5 * Math.sin((len(gx - (Math.floor(gx / big) + 0.5) * big, gy - (Math.floor(gy / big) + 0.5) * big) / size) * Math.PI);
    } else if (type === "dot") v = len(gx / size - Math.floor(gx / size) - 0.5, gy / size - Math.floor(gy / size) - 0.5) * 1.414;
    else v = 0.5 + 0.5 * Math.sin((gy / size) * Math.PI);
    c[0] = c[1] = c[2] = clamp((l - v) * contrast + 0.5, 0, 1);
  });
}

// ── Video ────────────────────────────────────────────────────────────────────────────────

function deinterlace(r: Raster, odd: boolean, interpolate: boolean): Raster {
  // Replaces one field (the odd or even rows) by duplicating or averaging the rows around it.
  const out = copyRaster(r);
  const row = r.w * 4;
  for (let y = odd ? 1 : 0; y < r.h; y += 2) {
    const [up, down] = [Math.max(0, y - 1), Math.min(r.h - 1, y + 1)];
    for (let i = 0; i < row; i++) out.d[y * row + i] = interpolate ? (r.d[up * row + i]! + r.d[down * row + i]!) / 2 : r.d[(odd ? up : down) * row + i]!;
  }
  return out;
}

function ntsc(c: Float64Array): void {
  // Limits chroma to what broadcast television can carry.
  const [r, g, b] = [c[0]!, c[1]!, c[2]!];
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  let i = 0.596 * r - 0.274 * g - 0.322 * b;
  let q = 0.211 * r - 0.523 * g + 0.312 * b;
  const m = len(i, q);
  if (m > 0.3) [i, q] = [(i * 0.3) / m, (q * 0.3) / m];
  c[0] = y + 0.956 * i + 0.621 * q;
  c[1] = y - 0.272 * i - 0.647 * q;
  c[2] = y - 1.106 * i + 1.703 * q;
}

// ── Other ────────────────────────────────────────────────────────────────────────────────

function convolve(r: Raster, filter: Of<"custom">): Raster {
  const { w, h } = r;
  const kernel = filter.kernel;
  const [kh, kw] = [kernel.length, Math.max(...kernel.map((row) => row.length))];
  const sum = kernel.flat().reduce((s, v) => s + v, 0);
  const scale = filter.scale ?? (sum || 1);
  const offset = (filter.offset ?? 0) / 255;
  const { rgb, a } = planes(r);
  const out = rgb.map((p) => {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let j = 0; j < kh; j++) {
          const row = kernel[j]!;
          const yy = clamp(y + j - (kh >> 1), 0, h - 1) * w;
          for (let i = 0; i < row.length; i++) if (row[i]) s += p[yy + clamp(x + i - (kw >> 1), 0, w - 1)]! * row[i]!;
        }
        o[y * w + x] = s / scale + offset;
      }
    return o;
  });
  return fromPlanes(w, h, out, a);
}

function hsbHsl(input: Of<"hsb-hsl">["input"], output: Of<"hsb-hsl">["output"]): (c: Float64Array) => void {
  const toHsv = (r: number, g: number, b: number): number[] => {
    const [mx, mn] = [Math.max(r, g, b), Math.min(r, g, b)];
    const d = mx - mn;
    let hue = 0;
    if (d > 0) hue = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [hue / 6, mx > 0 ? d / mx : 0, mx];
  };
  const toHsl = (r: number, g: number, b: number): number[] => {
    const [mx, mn] = [Math.max(r, g, b), Math.min(r, g, b)];
    const l = (mx + mn) / 2;
    const d = mx - mn;
    return [toHsv(r, g, b)[0]!, d > 0 ? d / (1 - Math.abs(2 * l - 1) || 1) : 0, l];
  };
  const hueRgb = (hh: number) => [0, 4, 2].map((o) => clamp(Math.abs(((hh * 6 + o) % 6) - 3) - 1, 0, 1));
  const fromHsv = (hh: number, s: number, v: number) => hueRgb(hh).map((kk) => v * (1 + (kk - 1) * s));
  const fromHsl = (hh: number, s: number, l: number) => hueRgb(hh).map((kk) => l + s * (kk - 0.5) * (1 - Math.abs(2 * l - 1)));
  // Reinterprets the channels: RGB → HSB writes hue, saturation and brightness into red, green and blue.
  return (c) => {
    const rgb = input === "rgb" ? [c[0]!, c[1]!, c[2]!] : input === "hsb" ? fromHsv(c[0]!, c[1]!, c[2]!) : fromHsl(c[0]!, c[1]!, c[2]!);
    const o = output === "rgb" ? rgb : output === "hsb" ? toHsv(rgb[0]!, rgb[1]!, rgb[2]!) : toHsl(rgb[0]!, rgb[1]!, rgb[2]!);
    [c[0], c[1], c[2]] = [o[0]!, o[1]!, o[2]!];
  };
}

function offset(r: Raster, dx: number, dy: number, edges: NonNullable<Of<"offset">["edges"]>): Raster {
  const { w, h } = r;
  if (edges === "repeat") return remap(r, (x, y, to) => ((to[0] = x - dx), (to[1] = y - dy)));
  const out = blank(r);
  const [ix, iy] = [Math.round(dx), Math.round(dy)];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let [sx, sy] = [x - ix, y - iy];
      if (edges === "wrap") [sx, sy] = [((sx % w) + w) % w, ((sy % h) + h) % h];
      else if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const [o, s] = [(y * w + x) * 4, (sy * w + sx) * 4];
      for (let c = 0; c < 4; c++) out.d[o + c] = r.d[s + c]!;
    }
  return out;
}

/** Camera Raw's Basic panel plus vignette and grain, in display (gamma) space. */
function cameraRaw(ctx: Ctx, image: Image, filter: Of<"camera-raw">): Image {
  const { kit, k, ox, oy } = ctx;
  const { ck } = kit;
  const v = (n: number | undefined) => (n ?? 0) / 100;
  const local = v(filter.clarity) !== 0 || v(filter.texture) !== 0 || v(filter.dehaze) !== 0;
  // Clarity lifts mid-tone contrast against a wide blur; texture, fine detail against a small one.
  const wide = local ? planes(soften(kit, image, 20)).rgb : undefined;
  const fine = local ? planes(soften(kit, image, 2)).rgb : undefined;
  const r = readRaster(ck, image);
  const [cx, cy] = ctx.at();
  const R = len(ctx.box.w, ctx.box.h) * k * 0.5;
  const ex = 2 ** (filter.exposure ?? 0);
  const [con, hi, sh, wh, bl] = [v(filter.contrast) * 0.6, v(filter.highlights), v(filter.shadows), v(filter.whites), v(filter.blacks)];
  const [temp, tint, vib, sat] = [v(filter.temperature), v(filter.tint), v(filter.vibrance) * 0.8, v(filter.saturation)];
  const [clar, tex, haze, vig, grain] = [v(filter.clarity), v(filter.texture), v(filter.dehaze), v(filter.vignette), (filter.grain ?? 0) / 300];
  const w = r.w;
  const unit = Math.max(1, k);
  const [wb0, wb1, wb2] = [ex * (1 + temp * 0.2 + tint * 0.05), ex * (1 - tint * 0.1), ex * (1 - temp * 0.2 + tint * 0.05)];
  const range = Math.max(1 + wh * 0.15 - bl * 0.1, 0.05);
  const tone = (x: number, t: number) => ((x + t - bl * 0.1) / range - 0.5) * (1 + con) + 0.5;
  return writeRaster(
    ck,
    mapColor(r, (c, i) => {
      const [o0, o1, o2] = [c[0]!, c[1]!, c[2]!];
      // White balance and exposure, then tone (highlights/shadows, whites/blacks, contrast).
      let [r0, g0, b0] = [o0 * wb0, o1 * wb1, o2 * wb2];
      const l0 = r0 * 0.299 + g0 * 0.587 + b0 * 0.114;
      const t = hi * 0.35 * smoothstep(0.5, 1, l0) + sh * 0.35 * (1 - smoothstep(0, 0.5, l0));
      [r0, g0, b0] = [tone(r0, t), tone(g0, t), tone(b0, t)];
      if (wide && fine) {
        const mid = (1 - Math.abs(l0 - 0.5) * 2) * clar * 0.8;
        const [w0, w1, w2] = [wide[0][i]!, wide[1][i]!, wide[2][i]!];
        r0 += (o0 - w0) * mid + (o0 - fine[0][i]!) * tex * 1.2;
        g0 += (o1 - w1) * mid + (o1 - fine[1][i]!) * tex * 1.2;
        b0 += (o2 - w2) * mid + (o2 - fine[2][i]!) * tex * 1.2;
        if (haze) {
          const d = Math.max(1 - haze * 0.3, 0.05);
          [r0, g0, b0] = [(r0 - w0 * haze * 0.15) / d, (g0 - w1 * haze * 0.15) / d, (b0 - w2 * haze * 0.15) / d];
        }
      }
      // Saturation everywhere; vibrance mostly where colour is muted. Then vignette and grain.
      const l = r0 * 0.299 + g0 * 0.587 + b0 * 0.114;
      const chroma = Math.max(r0, g0, b0) - Math.min(r0, g0, b0);
      const s = 1 + sat + vib * (1 - clamp(chroma * 1.5, 0, 1));
      const [px, py] = [(i % w) + 0.5, Math.floor(i / w) + 0.5];
      const vg = vig ? 1 + vig * smoothstep(0.5, 1.4, len(px - cx, py - cy) / R) : 1;
      const n = grain ? (hash(Math.floor((px + ox) / unit), Math.floor((py + oy) / unit), 61) - 0.5) * grain * 2 : 0;
      c[0] = (l + (r0 - l) * s) * vg + n;
      c[1] = (l + (g0 - l) * s) * vg + n;
      c[2] = (l + (b0 - l) * s) * vg + n;
    }),
  );
}

// ── Image › Adjustments ──────────────────────────────────────────────────────────────────

function shadowsHighlights(r: Raster, filter: Of<"shadows-highlights">, k: number): Raster {
  const { w, h } = r;
  const n = w * h;
  const { rgb, a } = planes(r);
  const L = luma(rgb, n);
  // Each pixel's surroundings decide how much it lifts or falls: dark neighbourhoods open up,
  // bright ones come down, so local contrast survives (a 3-box Gaussian of the brightness).
  const radius = (filter.radius ?? 30) * k;
  const rr = Math.sqrt((12 * radius * radius) / 9 + 1) / 2 - 0.5;
  const local = boxPlane(boxPlane(boxPlane(L, w, h, rr), w, h, rr), w, h, rr);
  const [s, hl, color] = [filter.shadows / 100, (filter.highlights ?? 0) / 100, (filter.color ?? 20) / 100];
  const out: Float32Array[] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const [l, b] = [L[i]!, local[i]!];
    let t = l ** (1 / (1 + 2.5 * s * (1 - b) ** 2));
    t = 1 - (1 - t) ** (1 / (1 + 2.5 * hl * b * b));
    const gain = l > 0.0001 ? t / l : 1;
    const sat = 1 + color * Math.min(1, Math.abs(t - l) * 4);
    for (let c = 0; c < 3; c++) out[c]![i] = t + (rgb[c]![i]! * gain - t) * sat;
  }
  return fromPlanes(w, h, out, a);
}

function equalize(r: Raster): Raster {
  // One brightness histogram over all three channels (where the layer has coverage), flattened.
  const hist = new Float64Array(256);
  const { rgb, a } = planes(r);
  const n = r.w * r.h;
  for (let i = 0; i < n; i++) if (a[i]! > 0) for (let c = 0; c < 3; c++) hist[Math.round(rgb[c]![i]! * 255)]! += 1;
  const total = hist.reduce((x, y) => x + y, 0) || 1;
  const map = new Float32Array(256);
  let acc = 0;
  const first = hist.findIndex((v) => v > 0);
  const base = first >= 0 ? hist[first]! : 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v]!;
    map[v] = clamp((acc - base) / Math.max(1, total - base), 0, 1);
  }
  return fromPlanes(r.w, r.h, rgb.map((p) => p.map((v) => map[Math.round(v * 255)]!)), a);
}

/** Mean and spread of each Lab channel over the covered pixels. */
function labStats(r: Raster): { mean: number[]; sd: number[] } {
  const lab = new Float64Array(3);
  const [sum, sq] = [[0, 0, 0], [0, 0, 0]];
  let count = 0;
  for (let i = 0; i < r.d.length; i += 4) {
    const al = r.d[i + 3]!;
    if (al < 1) continue;
    rgbToLab(r.d[i]! / al, r.d[i + 1]! / al, r.d[i + 2]! / al, lab);
    for (let c = 0; c < 3; c++) {
      sum[c]! += lab[c]!;
      sq[c]! += lab[c]! * lab[c]!;
    }
    count++;
  }
  const mean = sum.map((v) => v / Math.max(1, count));
  return { mean, sd: sq.map((v, c) => Math.sqrt(Math.max(0, v / Math.max(1, count) - mean[c]! ** 2))) };
}

function matchColor(ctx: Ctx, image: Image, filter: Of<"match-color">): Image {
  const { kit } = ctx;
  const sourceImage = filter.source ? kit.images.get(filter.source) : undefined;
  if (filter.source && !sourceImage) {
    kit.warnings.push(`match color: source "${filter.source}" isn't loaded`);
    return image;
  }
  const r = readRaster(kit.ck, image);
  const target = labStats(r);
  // Without a source, Neutralize pulls the colour cast (the a/b means) to grey.
  const source = sourceImage ? labStats(readRaster(kit.ck, sourceImage, false)) : { mean: [target.mean[0]!, 0, 0], sd: target.sd };
  const lum = (filter.luminance ?? 100) / 100;
  const intensity = (filter.intensity ?? 100) / 100;
  const keep = (filter.fade ?? 0) / 100;
  const goal = filter.neutralize && sourceImage ? { mean: [source.mean[0]!, (source.mean[1]! + 0) / 2, (source.mean[2]! + 0) / 2], sd: source.sd } : source;
  const lab = new Float64Array(3);
  const rgbOut = new Float64Array(3);
  return writeRaster(
    kit.ck,
    mapColor(r, (c) => {
      rgbToLab(c[0]!, c[1]!, c[2]!, lab);
      // Reinhard transfer: shift and scale each channel's spread to the goal's.
      const L = (lab[0]! - target.mean[0]!) * (goal.sd[0]! / (target.sd[0]! || 1)) + goal.mean[0]!;
      const A = ((lab[1]! - target.mean[1]!) * (goal.sd[1]! / (target.sd[1]! || 1)) + goal.mean[1]!) * intensity;
      const B = ((lab[2]! - target.mean[2]!) * (goal.sd[2]! / (target.sd[2]! || 1)) + goal.mean[2]!) * intensity;
      labToRgb(clamp(L * lum, 0, 100), A, B, rgbOut);
      for (let j = 0; j < 3; j++) c[j] = rgbOut[j]! + (c[j]! - rgbOut[j]!) * keep;
    }),
  );
}

function replaceColor(r: Raster, filter: Of<"replace-color">): Raster {
  const target = new Float64Array(3);
  rgbToLab(...(rgb01(filter.color) as [number, number, number]), target);
  const lab = new Float64Array(3);
  const shifted = new Float64Array(3);
  // Fuzziness is the colour distance (ΔE) at which the change has faded out.
  const reach = Math.max(1, filter.fuzziness * 0.5);
  return mapColor(r, (c) => {
    rgbToLab(c[0]!, c[1]!, c[2]!, lab);
    const d = Math.sqrt((lab[0]! - target[0]!) ** 2 + (lab[1]! - target[1]!) ** 2 + (lab[2]! - target[2]!) ** 2);
    const weight = clamp(1 - d / reach, 0, 1);
    if (!weight) return;
    shifted.set(c);
    shiftHsl(shifted, filter.hue ?? 0, filter.saturation ?? 0, filter.lightness ?? 0);
    for (let j = 0; j < 3; j++) c[j] = c[j]! + (shifted[j]! - c[j]!) * weight;
  });
}

// ── Retouching ───────────────────────────────────────────────────────────────────────────

function retouch(ctx: Ctx, r: Raster, filter: Of<"content-aware-fill"> | Of<"clone"> | Of<"heal">): Raster {
  const { k, box, ox, oy } = ctx;
  const { w, h } = r;
  const { rgb, a } = planes(r);
  const region = spotMask(filter.spots, w, h, box.x * k - ox, box.y * k - oy, box.w * k, box.h * k, k);
  // Work only around the spots (plus room to sample from), not the whole layer.
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let i = 0; i < w * h; i++)
    if (region[i]! > 0) {
      const [x, y] = [i % w, Math.floor(i / w)];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  if (x1 < 0) return r;
  const offset = filter.kind === "content-aware-fill" ? undefined : filter.offset;
  const reach = Math.max(48, Math.max(x1 - x0, y1 - y0) * 2) + (offset ? Math.max(Math.abs(offset[0]), Math.abs(offset[1])) * k : 0);
  const [cx0, cy0] = [Math.max(0, Math.floor(x0 - reach)), Math.max(0, Math.floor(y0 - reach))];
  const [cx1, cy1] = [Math.min(w - 1, Math.ceil(x1 + reach)), Math.min(h - 1, Math.ceil(y1 + reach))];
  const [cw, ch] = [cx1 - cx0 + 1, cy1 - cy0 + 1];
  const crop = (p: Float32Array) => {
    const out = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) out.set(p.subarray((cy0 + y) * w + cx0, (cy0 + y) * w + cx0 + cw), y * cw);
    return out;
  };
  const local = rgb.map(crop);
  const mask = crop(region);
  let fill: Float32Array[];
  if (offset) fill = shifted(local, cw, ch, offset[0] * k, offset[1] * k);
  else {
    const hole = new Uint8Array(cw * ch);
    for (let i = 0; i < hole.length; i++) hole[i] = mask[i]! > 0.01 ? 1 : 0;
    fill = contentAwareFill(local, hole, cw, ch);
  }
  const done = filter.kind === "heal" ? heal(local, fill, mask, cw, ch) : blendPlanes(local, fill, mask);
  const out = rgb.map((p) => p.slice());
  for (let c = 0; c < 3; c++) for (let y = 0; y < ch; y++) out[c]!.set(done[c]!.subarray(y * cw, (y + 1) * cw), (cy0 + y) * w + cx0);
  return fromPlanes(w, h, out, a);
}
