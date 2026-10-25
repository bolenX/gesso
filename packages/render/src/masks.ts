import type { BlendIf, Mask, Refine } from "@gesso/core";
import { rgbToLab } from "./cpu.js";

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

/** Mean over a (2r+1)² box, edges repeating; separable running sums, so its cost doesn't depend on r. */
function boxMean(p: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let k = -r; k <= r; k++) s += p[row + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s / n;
      s += p[row + Math.min(w - 1, x + r + 1)]! - p[row + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

/**
 * Select and Mask: the band within `radius` of the mask's edge is treated as unknown, like Refine Edge's
 * edge detection. There, each pixel's opacity comes from its colour: where it falls between the subject's
 * colour (averaged from the solid inside nearby) and the background's (from the clear outside nearby). Hair
 * strands and leaves that are darker or lighter than the background come through, even past the rough edge.
 * The result is then smoothed, hardened and shifted. Decontaminating replaces the old background's colour in
 * the soft edge with the subject's. `content` and the result are straight RGBA; `scale` is the render scale.
 */
export function refineMask(content: Uint8Array, coverage: Uint8Array, w: number, h: number, refine: Refine, scale = 1): { coverage: Uint8Array; content?: Uint8Array } {
  const n = w * h;
  const r = Math.max(1, Math.round((refine.radius ?? 4) * scale));
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) m[i] = coverage[i]! / 255;
  // The unknown band: anything whose neighbourhood holds both inside and outside.
  const near = boxMean(m, w, h, r);
  // Solid inside and clear outside, and the average colour of each around every pixel (a wider window, to find samples).
  const fg = m.map((v) => (v >= 0.98 ? 1 : 0));
  const bg = m.map((v) => (v <= 0.02 ? 1 : 0));
  const reach = r * 2;
  const fgWeight = boxMean(fg, w, h, reach);
  const bgWeight = boxMean(bg, w, h, reach);
  const fgColour = [0, 1, 2].map((c) => boxMean(fg.map((f, i) => f * content[i * 4 + c]!), w, h, reach));
  const bgColour = [0, 1, 2].map((c) => boxMean(bg.map((b, i) => b * content[i * 4 + c]!), w, h, reach));
  let alpha: Float32Array = new Float32Array(n);
  const F = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    alpha[i] = m[i]!;
    if (near[i]! <= 0.001 || near[i]! >= 0.999 || fgWeight[i]! < 1e-3 || bgWeight[i]! < 1e-3) continue;
    let [dot, len] = [0, 0];
    for (let c = 0; c < 3; c++) {
      const f = fgColour[c]![i]! / fgWeight[i]!;
      const b = bgColour[c]![i]! / bgWeight[i]!;
      F[i * 3 + c] = f;
      dot += (content[i * 4 + c]! - b) * (f - b);
      len += (f - b) ** 2;
    }
    // Inside and outside look alike here: colour can't tell them apart, so the rough mask stands.
    if (len < 400) continue;
    alpha[i] = Math.min(1, Math.max(0, dot / len));
  }
  if (refine.smooth) {
    const k = Math.max(1, Math.round((r * refine.smooth) / 200));
    alpha = boxMean(alpha, w, h, k);
  }
  const shift = (refine.shift ?? 0) / 200;
  const gain = 1 + ((refine.contrast ?? 0) / 100) * 9;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, Math.max(0, (alpha[i]! - 0.5 + shift) * gain + 0.5));
    alpha[i] = v;
    out[i] = Math.round(v * 255);
  }
  if (!refine.decontaminate) return { coverage: out };
  const amount = refine.decontaminate / 100;
  const clean = content.slice();
  for (let i = 0; i < n; i++) {
    const a = alpha[i]!;
    if (a <= 0 || a >= 1 || fgWeight[i]! < 1e-3 || F[i * 3]! + F[i * 3 + 1]! + F[i * 3 + 2]! === 0) continue;
    // The pixel's colour is a·subject + (1 − a)·background: keep the subject's part.
    const t = amount * (1 - a);
    for (let c = 0; c < 3; c++) clean[i * 4 + c] = Math.round(Math.min(255, Math.max(0, content[i * 4 + c]! + (F[i * 3 + c]! - content[i * 4 + c]!) * t)));
  }
  return { coverage: out, content: clean };
}
