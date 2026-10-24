import type { AdjustmentLayer } from "@gesso/core";

// Adjustments run on the CPU over unpremultiplied 8-bit RGBA, in gamma-encoded
// space like Photoshop. The formulas are first approximations; golden tests
// against Photoshop renders will calibrate them.

type Adjustment = AdjustmentLayer["adjustment"];
type Lut = Uint8Array;

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Applies an adjustment in place to unpremultiplied RGBA pixels. */
export function applyAdjustment(pixels: Uint8Array, adjustment: Adjustment): void {
  if (adjustment.kind === "hue-saturation") return hueSaturation(pixels, adjustment);
  if (adjustment.kind === "gradient-map") return gradientMap(pixels, adjustment);
  const luts = channelLuts(adjustment);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = luts[0][pixels[i]!]!;
    pixels[i + 1] = luts[1][pixels[i + 1]!]!;
    pixels[i + 2] = luts[2][pixels[i + 2]!]!;
  }
}

/** Photoshop's gradient map: each pixel's luminosity picks a colour along the gradient. */
function gradientMap(pixels: Uint8Array, adjustment: Extract<Adjustment, { kind: "gradient-map" }>): void {
  const table = gradientTable(adjustment.stops, adjustment.reverse);
  for (let i = 0; i < pixels.length; i += 4) {
    const l = Math.round(0.3 * pixels[i]! + 0.59 * pixels[i + 1]! + 0.11 * pixels[i + 2]!);
    pixels[i] = table[l * 3]!;
    pixels[i + 1] = table[l * 3 + 1]!;
    pixels[i + 2] = table[l * 3 + 2]!;
  }
}

/** 256 RGB colours along the stops, linearly interpolated. */
export function gradientTable(stops: Array<{ offset: number; color: string }>, reverse = false): Uint8Array {
  const sorted = [...stops].sort((a, b) => a.offset - b.offset).map((s) => ({ at: s.offset, rgb: [1, 3, 5].map((k) => parseInt(s.color.slice(k, k + 2), 16)) }));
  const table = new Uint8Array(256 * 3);
  for (let v = 0; v < 256; v++) {
    const t = reverse ? 1 - v / 255 : v / 255;
    const next = sorted.findIndex((s) => s.at >= t);
    const hi = sorted[next === -1 ? sorted.length - 1 : next]!;
    const lo = sorted[next <= 0 ? (next === -1 ? sorted.length - 1 : 0) : next - 1]!;
    const f = hi.at === lo.at ? 0 : (t - lo.at) / (hi.at - lo.at);
    for (let c = 0; c < 3; c++) table[v * 3 + c] = clamp(lo.rgb[c]! + (hi.rgb[c]! - lo.rgb[c]!) * f);
  }
  return table;
}

function channelLuts(adjustment: Exclude<Adjustment, { kind: "hue-saturation" | "gradient-map" }>): [Lut, Lut, Lut] {
  const identity = lut((v) => v);
  switch (adjustment.kind) {
    case "brightness-contrast": {
      const factor = 1 + adjustment.contrast / 100;
      const l = lut((v) => (v + adjustment.brightness - 128) * factor + 128);
      return [l, l, l];
    }
    case "levels": {
      const { inputBlack: ib, inputWhite: iw, gamma } = adjustment;
      const ob = adjustment.outputBlack ?? 0;
      const ow = adjustment.outputWhite ?? 255;
      const l = lut((v) => {
        const t = Math.min(Math.max((v - ib) / Math.max(iw - ib, 1), 0), 1);
        return ob + Math.pow(t, 1 / gamma) * (ow - ob);
      });
      return [l, l, l];
    }
    case "curves": {
      const l = curveLut(adjustment.points);
      const channel = adjustment.channel ?? "rgb";
      if (channel === "rgb") return [l, l, l];
      return [channel === "red" ? l : identity, channel === "green" ? l : identity, channel === "blue" ? l : identity];
    }
  }
}

function lut(f: (v: number) => number): Lut {
  const table = new Uint8Array(256);
  for (let v = 0; v < 256; v++) table[v] = clamp(f(v));
  return table;
}

/** Monotone cubic (Fritsch–Carlson) curve through the control points, flat beyond the ends. */
export function curveLut(points: Array<[number, number]>): Lut {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = xs.slice(1).map((x, i) => (ys[i + 1]! - ys[i]!) / (x - xs[i]! || 1));
  const m = xs.map((_, i) => (i === 0 ? d[0]! : i === n - 1 ? d[n - 2]! : d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i]!;
      m[i + 1] = t * b * d[i]!;
    }
  }
  return lut((v) => {
    if (v <= xs[0]!) return ys[0]!;
    if (v >= xs[n - 1]!) return ys[n - 1]!;
    let i = 0;
    while (v > xs[i + 1]!) i++;
    const h = xs[i + 1]! - xs[i]!;
    const t = (v - xs[i]!) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i]! + (t3 - 2 * t2 + t) * h * m[i]! + (-2 * t3 + 3 * t2) * ys[i + 1]! + (t3 - t2) * h * m[i + 1]!
    );
  });
}

function hueSaturation(pixels: Uint8Array, adj: Extract<Adjustment, { kind: "hue-saturation" }>): void {
  const sat = 1 + adj.saturation / 100;
  const light = adj.lightness / 100;
  for (let i = 0; i < pixels.length; i += 4) {
    const [h0, s0, l] = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    const h = (h0 + adj.hue / 360 + 1) % 1;
    const s = Math.min(Math.max(s0 * sat, 0), 1);
    let [r, g, b] = hslToRgb(h, s, l);
    if (light > 0) [r, g, b] = [r + (255 - r) * light, g + (255 - g) * light, b + (255 - b) * light];
    else if (light < 0) [r, g, b] = [r * (1 + light), g * (1 + light), b * (1 + light)];
    pixels[i] = clamp(r);
    pixels[i + 1] = clamp(g);
    pixels[i + 2] = clamp(b);
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}
