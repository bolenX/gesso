import type { Artboard, Filter, Frame, Layer } from "./schema.js";

// Re-places a design on a new size. Layers keep whichever edge they sit against
// (or stay centred), scale uniformly so nothing distorts, and anything that spans
// the whole width or height (backgrounds, bands) stretches to the new edges.

type Size = { w: number; h: number };
type Box = { x: number; y: number; w: number; h: number };

export type ReflowOptions = {
  /** Uniform scale for sizes, type and margins. Defaults to the smaller of the two axis ratios. */
  scale?: number;
};

/** Spans this much of an axis or more: treated as full-bleed on that axis. */
const BLEED = 0.95;

export function reflowArtboard(source: Artboard, to: Size, options: ReflowOptions = {}): { layers: Layer[]; scale: number } {
  const from = { w: source.frame.w, h: source.frame.h };
  const scale = options.scale ?? Math.min(to.w / from.w, to.h / from.h);
  return { layers: reflowLayers(structuredClone(source.layers), from, to, scale), scale };
}

function reflowLayers(layers: Layer[], from: Size, to: Size, s: number): Layer[] {
  return layers.map((layer) => reflowLayer(layer, from, to, s));
}

function reflowLayer(layer: Layer, from: Size, to: Size, s: number): Layer {
  const before = boxOf(layer.frame, from);
  const frame = reflowFrame(layer.frame, from, to, s);
  const out = { ...layer, frame } as Layer;
  scaleContent(out, s);
  if (out.type === "group") {
    // Children are laid out inside the group's box, so reflow them against its old and new size.
    const after = boxOf(frame, to);
    out.children = before && after ? reflowLayers(out.children, before, after, s) : out.children;
  }
  if (out.type === "smart" && out.quad && before) {
    const after = boxOf(frame, to)!;
    out.quad = out.quad.map(([x, y]) => [
      after.x + ((x - before.x) / (before.w || 1)) * after.w,
      after.y + ((y - before.y) / (before.h || 1)) * after.h,
    ]) as typeof out.quad;
  }
  return out;
}

/** The absolute box for frames that have one; anchored frames reflow on their own. */
function boxOf(frame: Frame, parent: Size): Box | undefined {
  if ("x" in frame) return frame;
  const pct = (v: number | string | undefined, of: number) => (typeof v === "string" ? (parseFloat(v) / 100) * of : v);
  const w = pct(frame.w, parent.w);
  const h = pct(frame.h, parent.h);
  if (w === undefined || h === undefined) return undefined;
  return { x: (parent.w - w) / 2, y: (parent.h - h) / 2, w, h };
}

function reflowFrame(frame: Frame, from: Size, to: Size, s: number): Frame {
  if (!("x" in frame)) {
    // Anchored: percentages already follow the artboard; pixel lengths scale.
    const px = <T>(v: T) => (typeof v === "number" ? ((v as number) * s) as T : v);
    return {
      ...frame,
      ...(frame.margin !== undefined ? { margin: Array.isArray(frame.margin) ? [frame.margin[0] * s, frame.margin[1] * s] : frame.margin * s } : {}),
      ...(frame.w !== undefined ? { w: px(frame.w) } : {}),
      ...(frame.h !== undefined ? { h: px(frame.h) } : {}),
    };
  }
  const [x, w] = axis(frame.x, frame.w, from.w, to.w, s);
  const [y, h] = axis(frame.y, frame.h, from.h, to.h, s);
  return { x: round(x), y: round(y), w: round(w), h: round(h) };
}

/** One axis: stretch if full-bleed, else keep to the nearer edge, or the centre when neither is clearly nearer. */
function axis(start: number, length: number, from: number, to: number, s: number): [number, number] {
  const end = from - start - length;
  if (length >= from * BLEED) return [start * s, to - start * s - Math.max(0, end) * s];
  const size = length * s;
  if (start <= end * 0.5) return [start * s, size];
  if (end <= start * 0.5) return [to - end * s - size, size];
  return [to / 2 + (start + length / 2 - from / 2) * s - size / 2, size];
}

/** Scales the pixel values inside a layer: type, strokes, corner radii, blur. */
function scaleContent(layer: Layer, s: number): void {
  if (s === 1) return;
  if (layer.filters) layer.filters = layer.filters.map((f) => scaleFilter(f, s));
  if (layer.mask && "feather" in layer.mask && layer.mask.feather) layer.mask = { ...layer.mask, feather: layer.mask.feather * s };
  if (layer.type === "text") {
    layer.style = { ...layer.style, size: round(layer.style.size * s), ...(layer.style.leading ? { leading: round(layer.style.leading * s) } : {}) };
    if (layer.runs) layer.runs = layer.runs.map((r) => (r.size ? { ...r, size: round(r.size * s) } : r));
    if (layer.box?.kind === "area" && layer.box.minSize) layer.box = { ...layer.box, minSize: round(layer.box.minSize * s) };
  }
  if (layer.type === "shape") {
    if (layer.stroke) layer.stroke = { ...layer.stroke, width: layer.stroke.width * s };
    if (layer.shape.kind === "rect" && layer.shape.radius) layer.shape = { ...layer.shape, radius: layer.shape.radius * s };
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

/** A filter's pixel sizes scaled by s, kept within each parameter's range. Sizes relative to the layer stay. */
function scaleFilter(f: Filter, s: number): Filter {
  const by = (v: number, lo = 0, hi = Infinity) => Math.min(hi, Math.max(lo, v * s));
  switch (f.kind) {
    case "gaussian-blur":
    case "box-blur":
    case "shape-blur":
    case "smart-blur":
    case "surface-blur":
    case "lens-blur":
    case "iris-blur":
    case "tilt-shift":
    case "high-pass":
    case "maximum":
    case "minimum":
    case "smart-sharpen":
      return { ...f, radius: by(f.radius, 0.1) };
    case "field-blur":
      return { ...f, points: f.points.map((p) => ({ ...p, radius: by(p.radius) })) };
    case "glass":
      return { ...f, size: by(f.size, 0.1), amount: f.amount * s };
    case "motion-blur":
    case "path-blur":
      return { ...f, distance: by(f.distance, 0.1) };
    case "noise":
      return f.size ? { ...f, size: by(f.size, 0.1) } : f;
    case "sharpen":
      return f.radius ? { ...f, radius: by(f.radius, 0.1) } : f;
    case "wave":
      return { ...f, amplitude: f.amplitude * s, wavelength: by(f.wavelength, 0.1) };
    case "shear":
      return { ...f, offsets: f.offsets.map((o) => o * s) };
    case "pixelate":
      return { ...f, size: by(f.size, 0.1) };
    case "displace":
      return { ...f, scale: [f.scale[0] * s, f.scale[1] * s] };
    case "color-halftone":
      return { ...f, radius: by(f.radius, 2, 127) };
    case "crystallize":
    case "pointillize":
      return { ...f, size: by(f.size, 3, 300) };
    case "emboss":
      return f.height ? { ...f, height: by(f.height, 1, 10) } : f;
    case "extrude":
      return { ...f, size: by(f.size, 2, 255) };
    case "glowing-edges":
      return f.width ? { ...f, width: by(f.width, 1, 14) } : f;
    case "oil-paint":
      return { ...f, stylization: by(f.stylization, 0.1, 10) };
    case "halftone-pattern":
      return { ...f, size: by(f.size, 1, 12) };
    case "clouds":
    case "difference-clouds":
      return f.scale ? { ...f, scale: by(f.scale, 0.1) } : f;
    case "offset":
      return { ...f, x: f.x * s, y: f.y * s };
    default:
      // Radial blurs, twirl, pinch and the like are relative to the layer; the rest have no size.
      return f;
  }
}
