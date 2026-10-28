import type { BlendIf, Mask, Refine } from "@gesso/core";
import { rgbToLab } from "./cpu.js";
import { boxMean, colourLine, estimateForeground, makeTrimap, matte } from "./matting.js";

// Masks computed from pixels, and Blend If. Both read straight 8-bit RGBA.

type Computed = Extract<Mask, { kind: "luminosity" | "color-range" | "channel" }>;

const smooth = (a: number, b: number, v: number) => {
  if (b <= a) return v >= b ? 1 : 0;
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The mask's coverage (0..255) for each pixel of `pixels`; transparent source pixels give none. */
export function computeMask(pixels: Uint8Array, mask: Computed): Uint8Array {
  const n = pixels.length / 4;
  const out = new Uint8Array(n);
  const lab = new Float64Array(3);
  const target = new Float64Array(3);
  if (mask.kind === "color-range") rgbToLab(...([1, 3, 5].map((k) => parseInt(mask.color.slice(k, k + 2), 16) / 255) as [number, number, number]), target);
  const reach = mask.kind === "color-range" ? Math.max(1, mask.fuzziness * 0.5) : 1;
  const level = mask.kind === "luminosity" ? (mask.level ?? 1) : 1;
  const channel = mask.kind === "channel" ? { red: 0, green: 1, blue: 2 }[mask.channel] : 0;
  const [black, white] = mask.kind === "channel" ? [mask.black ?? 0, mask.white ?? 255] : [0, 255];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let m: number;
    if (mask.kind === "luminosity") {
      // Photoshop's luminosity (the RGB composite channel).
      const l = (0.3 * pixels[o]! + 0.59 * pixels[o + 1]! + 0.11 * pixels[o + 2]!) / 255;
      if (Array.isArray(mask.range)) {
        const [lo, hi] = [Math.min(...mask.range) / 255, Math.max(...mask.range) / 255];
        const soft = (mask.softness ?? 16) / 255;
        m = smooth(lo - soft, lo, l) * (1 - smooth(hi, hi + soft, l));
      } else if (mask.range === "lights") m = l ** level;
      else if (mask.range === "darks") m = (1 - l) ** level;
      else m = (4 * l * (1 - l)) ** level;
    } else if (mask.kind === "color-range") {
      rgbToLab(pixels[o]! / 255, pixels[o + 1]! / 255, pixels[o + 2]! / 255, lab);
      const d = Math.sqrt((lab[0]! - target[0]!) ** 2 + (lab[1]! - target[1]!) ** 2 + (lab[2]! - target[2]!) ** 2);
      m = Math.max(0, 1 - d / reach);
    } else {
      m = Math.min(1, Math.max(0, (pixels[o + channel]! - black) / Math.max(1, white - black)));
    }
    if (mask.invert) m = 1 - m;
    out[i] = Math.round(m * (pixels[o + 3]! / 255) * 255);
  }
  return out;
}

/** How visible each pixel of a range test is: 0 outside [black, white], fading in across the split sliders. */
function inRange(v: number, [b0, b1, w0, w1]: readonly number[]): number {
  if (v < b0! || v > w1!) return 0;
  const rise = b1! > b0! ? Math.min(1, (v - b0!) / (b1! - b0!)) : 1;
  const fall = w1! > w0! ? Math.min(1, (w1! - v) / (w1! - w0!)) : 1;
  return Math.min(rise, fall);
}

/**
 * Blend If: per-pixel visibility (0..1) of a layer from its own pixels and those beneath it,
 * both straight RGBA of the same size.
 */
export function blendIfWeights(layer: Uint8Array, below: Uint8Array, blendIf: BlendIf): Float32Array {
  const n = layer.length / 4;
  const out = new Float32Array(n).fill(1);
  const value = (px: Uint8Array, o: number) => {
    switch (blendIf.channel ?? "gray") {
      case "red":
        return px[o]!;
      case "green":
        return px[o + 1]!;
      case "blue":
        return px[o + 2]!;
      default:
        return 0.3 * px[o]! + 0.59 * px[o + 1]! + 0.11 * px[o + 2]!;
    }
  };
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let w = 1;
    if (blendIf.this) w *= inRange(value(layer, o), blendIf.this);
    if (blendIf.underlying) w *= inRange(value(below, o), blendIf.underlying);
    out[i] = w;
  }
  return out;
}

// ── Calculations ─────────────────────────────────────────────────────────────────────────

type Calculations = Extract<Mask, { kind: "calculations" }>;

/** One channel of straight RGBA as 0..1 (gray is luminosity), inverted if asked; transparent pixels read as 0. */
function channelOf(pixels: Uint8Array, i: number, spec: Calculations["a"]): number {
  const o = i * 4;
  const a = pixels[o + 3]! / 255;
  const v = spec.channel === "gray" ? (0.3 * pixels[o]! + 0.59 * pixels[o + 1]! + 0.11 * pixels[o + 2]!) / 255 : pixels[o + { red: 0, green: 1, blue: 2 }[spec.channel]]! / 255;
  const c = v * a;
  return spec.invert ? 1 - c : c;
}

/** Image › Calculations: channel b blended onto channel a, at the given opacity, then levels and invert. */
export function computeCalculations(a: Uint8Array, b: Uint8Array, mask: Calculations): Uint8Array {
  const n = a.length / 4;
  const out = new Uint8Array(n);
  const opacity = mask.opacity ?? 1;
  const [black, white] = [(mask.black ?? 0) / 255, (mask.white ?? 255) / 255];
  for (let i = 0; i < n; i++) {
    const [x, y] = [channelOf(a, i, mask.a), channelOf(b, i, mask.b)];
    let v: number;
    switch (mask.blend) {
      case "multiply": v = x * y; break;
      case "screen": v = 1 - (1 - x) * (1 - y); break;
      case "overlay": v = x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y); break;
      case "hard-light": v = y < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y); break;
      case "soft-light": v = y < 0.5 ? x - (1 - 2 * y) * x * (1 - x) : x + (2 * y - 1) * ((x < 0.25 ? ((16 * x - 12) * x + 4) * x : Math.sqrt(x)) - x); break;
      case "add": v = x + y; break;
      case "subtract": v = x - y; break;
      case "difference": v = Math.abs(x - y); break;
      case "darken": v = Math.min(x, y); break;
      case "lighten": v = Math.max(x, y); break;
    }
    v = x + (Math.min(1, Math.max(0, v)) - x) * opacity;
    v = white > black ? (v - black) / (white - black) : v >= black ? 1 : 0;
    v = Math.min(1, Math.max(0, v));
    out[i] = Math.round((mask.invert ? 1 - v : v) * 255);
  }
  return out;
}

// ── Refine Edge ──────────────────────────────────────────────────────────────────────────

/**
 * Select and Mask. The band within `radius` of the mask's edge (with smart radius, only where the edge has
 * fine detail) is solved for opacity from the layer's own pixels by closed-form matting, so hair and fur come
 * through strand by strand (matting.ts). The result is then smoothed, hardened and shifted. Decontaminating
 * replaces the old background's colour in the soft edge with the subject's own, estimated pixel by pixel.
 * `content` and the result are straight RGBA; `scale` is the render scale. Only the area around the edge is
 * worked on.
 */
export function refineMask(content: Uint8Array, coverage: Uint8Array, w: number, h: number, refine: Refine, scale = 1): { coverage: Uint8Array; content?: Uint8Array } {
  const n = w * h;
  const r = Math.max(1, Math.round((refine.radius ?? 4) * scale));
  const reach = r * 2;
  // The area to work on: around every soft pixel and every step between in and out.
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const v = coverage[i]!;
      const edge = (x + 1 < w && v >= 128 !== coverage[i + 1]! >= 128) || (y + 1 < h && v >= 128 !== coverage[i + w]! >= 128);
      if (!edge && (v <= 5 || v >= 250)) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const alpha = new Float64Array(n);
  for (let i = 0; i < n; i++) alpha[i] = coverage[i]! / 255;
  let fore: { F: [Float64Array, Float64Array, Float64Array]; box: [number, number, number, number] } | undefined;
  if (x1 >= 0) {
    const margin = reach + r + 4;
    [x0, y0, x1, y1] = [Math.max(0, x0 - margin), Math.max(0, y0 - margin), Math.min(w - 1, x1 + margin), Math.min(h - 1, y1 + margin)];
    const [cw, ch] = [x1 - x0 + 1, y1 - y0 + 1];
    const crop = (get: (i: number) => number) => {
      const out = new Float64Array(cw * ch);
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) out[y * cw + x] = get((y + y0) * w + x + x0);
      return out;
    };
    const I = [0, 1, 2].map((c) => crop((i) => content[i * 4 + c]! / 255)) as [Float64Array, Float64Array, Float64Array];
    const m = crop((i) => alpha[i]!);
    const estimate = colourLine(I, m, cw, ch, reach);
    const tri = makeTrimap(I, m, cw, ch, r, refine.smartRadius ?? false, estimate);
    const solved = matte(I, tri, estimate, cw, ch, { prior: { value: estimate, weight: estimate.confidence! } });
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) alpha[(y + y0) * w + x + x0] = solved[y * cw + x]!;
    if (refine.decontaminate) fore = { F: estimateForeground(I, solved, cw, ch), box: [x0, y0, cw, ch] };
  }
  let shaped: Float64Array = alpha;
  if (refine.smooth) shaped = boxMean(alpha, w, h, Math.max(1, Math.round((r * refine.smooth) / 200)));
  const shift = (refine.shift ?? 0) / 200;
  const gain = 1 + ((refine.contrast ?? 0) / 100) * 9;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.max(0, (shaped[i]! - 0.5 + shift) * gain + 0.5));
    shaped[i] = v;
    out[i] = Math.round(v * 255);
  }
  if (!refine.decontaminate || !fore) return { coverage: out };
  const amount = refine.decontaminate / 100;
  const clean = content.slice();
  const [bx, by, bw, bh] = fore.box;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const i = (y + by) * w + x + bx;
      const a = shaped[i]!;
      if (a <= 0 || a >= 1) continue;
      // The pixel's colour is a·subject + (1 − a)·background: keep the subject's part.
      for (let c = 0; c < 3; c++) {
        const f = fore.F[c]![y * bw + x]! * 255;
        clean[i * 4 + c] = Math.round(Math.min(255, Math.max(0, content[i * 4 + c]! + (f - content[i * 4 + c]!) * amount)));
      }
    }
  }
  return { coverage: out, content: clean };
}
