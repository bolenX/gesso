import type { BlendIf, Mask } from "@gesso/core";
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
