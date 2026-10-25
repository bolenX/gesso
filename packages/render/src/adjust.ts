import type { AdjustmentLayer } from "@gesso/core";

// Adjustments run on the CPU over unpremultiplied 8-bit RGBA, in gamma-encoded space like
// Photoshop (Exposure works in linear light, as Photoshop's does). Per-channel adjustments
// become lookup tables; the rest work per pixel.

type Adjustment = AdjustmentLayer["adjustment"];
type Of<K extends Adjustment["kind"]> = Extract<Adjustment, { kind: K }>;
type Lut = Uint8Array;

/** A 3D colour lookup table: `size`³ RGB entries, red varying fastest (the .cube order). */
export type Lut3D = { size: number; data: Float32Array; min: [number, number, number]; max: [number, number, number] };

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Applies an adjustment in place to unpremultiplied RGBA pixels. LUT assets come in `luts`, by asset id. */
export function applyAdjustment(pixels: Uint8Array, adjustment: Adjustment, luts?: Map<string, Lut3D>): void {
  switch (adjustment.kind) {
    case "hue-saturation":
      return hueSaturation(pixels, adjustment);
    case "gradient-map":
      return gradientMap(pixels, adjustment);
    case "vibrance":
      return perPixel(pixels, vibrance(adjustment));
    case "color-balance":
      return perPixel(pixels, colorBalance(adjustment));
    case "black-white":
      return perPixel(pixels, blackWhite(adjustment));
    case "photo-filter":
      return perPixel(pixels, photoFilter(adjustment));
    case "channel-mixer":
      return perPixel(pixels, channelMixer(adjustment));
    case "threshold":
      return perPixel(pixels, (c) => c.fill(0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]! >= adjustment.level / 255 ? 1 : 0));
    case "selective-color":
      return perPixel(pixels, selectiveColor(adjustment));
    case "color-lookup": {
      const lut = luts?.get(adjustment.lut);
      if (!lut) throw new Error(`Color Lookup needs the LUT asset "${adjustment.lut}"`);
      return perPixel(pixels, (c) => lookup(lut, c));
    }
    default: {
      const tables = channelLuts(adjustment);
      for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = tables[0][pixels[i]!]!;
        pixels[i + 1] = tables[1][pixels[i + 1]!]!;
        pixels[i + 2] = tables[2][pixels[i + 2]!]!;
      }
    }
  }
}

/** Runs fn over each pixel's colour in 0..1 (edited in place). */
function perPixel(pixels: Uint8Array, fn: (c: Float64Array) => void): void {
  const c = new Float64Array(3);
  for (let i = 0; i < pixels.length; i += 4) {
    c[0] = pixels[i]! / 255;
    c[1] = pixels[i + 1]! / 255;
    c[2] = pixels[i + 2]! / 255;
    fn(c);
    pixels[i] = clamp(c[0]! * 255);
    pixels[i + 1] = clamp(c[1]! * 255);
    pixels[i + 2] = clamp(c[2]! * 255);
  }
}

// Photoshop's non-separable blend helpers (luminosity weights 0.3, 0.59, 0.11).
const lum = (c: ArrayLike<number>) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
/** Sets c's luminosity to l, keeping its hue and saturation (in place). */
function setLum(c: Float64Array, l: number): void {
  const d = l - lum(c);
  c[0]! += d;
  c[1]! += d;
  c[2]! += d;
  const L = lum(c);
  const [n, x] = [Math.min(c[0]!, c[1]!, c[2]!), Math.max(c[0]!, c[1]!, c[2]!)];
  for (let k = 0; k < 3; k++) {
    if (n < 0) c[k] = L + ((c[k]! - L) * L) / (L - n || 1);
    if (x > 1) c[k] = L + ((c[k]! - L) * (1 - L)) / (x - L || 1);
  }
}

/** Photoshop's gradient map: each pixel's luminosity picks a colour along the gradient. */
function gradientMap(pixels: Uint8Array, adjustment: Of<"gradient-map">): void {
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

type Channel = "rgb" | "red" | "green" | "blue";
const IDENTITY = lut((v) => v);
/** Puts a table on one channel or all three; the others pass through. */
const onChannel = (table: Lut, channel: Channel = "rgb"): [Lut, Lut, Lut] =>
  channel === "rgb" ? [table, table, table] : [channel === "red" ? table : IDENTITY, channel === "green" ? table : IDENTITY, channel === "blue" ? table : IDENTITY];
/** Applies b after a, per channel. */
const chain = (a: [Lut, Lut, Lut], b: [Lut, Lut, Lut]): [Lut, Lut, Lut] => [0, 1, 2].map((c) => a[c]!.map((v) => b[c]![v]!)) as [Lut, Lut, Lut];

function channelLuts(adjustment: Of<"brightness-contrast" | "levels" | "curves" | "exposure" | "invert" | "posterize">): [Lut, Lut, Lut] {
  switch (adjustment.kind) {
    case "brightness-contrast": {
      const factor = 1 + adjustment.contrast / 100;
      return onChannel(lut((v) => (v + adjustment.brightness - 128) * factor + 128));
    }
    case "levels": {
      const { inputBlack: ib, inputWhite: iw, gamma } = adjustment;
      const ob = adjustment.outputBlack ?? 0;
      const ow = adjustment.outputWhite ?? 255;
      const l = lut((v) => {
        const t = Math.min(Math.max((v - ib) / Math.max(iw - ib, 1), 0), 1);
        return ob + Math.pow(t, 1 / gamma) * (ow - ob);
      });
      return onChannel(l, adjustment.channel);
    }
    case "curves": {
      let tables = onChannel(curveLut(adjustment.points), adjustment.channel);
      for (const channel of ["red", "green", "blue"] as const) {
        const points = adjustment[channel];
        if (points) tables = chain(tables, onChannel(curveLut(points), channel));
      }
      return tables;
    }
    case "exposure": {
      // In linear light: scale by 2^exposure, add the offset, then apply gamma.
      const k = 2 ** adjustment.exposure;
      const offset = adjustment.offset ?? 0;
      const g = 1 / (adjustment.gamma ?? 1);
      return onChannel(
        lut((v) => {
          const x = toLinear(v / 255) * k + offset;
          return toSrgb(Math.sign(x) * Math.abs(x) ** g) * 255;
        }),
      );
    }
    case "invert":
      return onChannel(lut((v) => 255 - v));
    case "posterize": {
      const n = adjustment.levels;
      return onChannel(lut((v) => (Math.min(n - 1, Math.floor((v * n) / 256)) * 255) / (n - 1)));
    }
  }
}

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

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

/** Photoshop's colour ranges by hue (degrees): full effect within 15° of the centre, fading out by 45°. */
const RANGE_HUES = { reds: 0, yellows: 60, greens: 120, cyans: 180, blues: 240, magentas: 300 } as const;
const rangeWeight = (hue: number, centre: number) => {
  const d = Math.abs(((hue - centre + 540) % 360) - 180);
  return d <= 15 ? 1 : d >= 45 ? 0 : (45 - d) / 30;
};

function hueSaturation(pixels: Uint8Array, adj: Of<"hue-saturation">): void {
  const ranges = Object.entries(adj.ranges ?? {}).filter(([, v]) => v) as Array<[keyof typeof RANGE_HUES, { hue?: number; saturation?: number; lightness?: number }]>;
  for (let i = 0; i < pixels.length; i += 4) {
    const [h0, s0, l] = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!);
    let [hue, saturation, lightness] = [adj.hue, adj.saturation, adj.lightness];
    for (const [name, shift] of ranges) {
      const w = s0 > 0 ? rangeWeight(h0 * 360, RANGE_HUES[name]) : 0;
      if (!w) continue;
      hue += (shift.hue ?? 0) * w;
      saturation += (shift.saturation ?? 0) * w;
      lightness += (shift.lightness ?? 0) * w;
    }
    const sat = 1 + Math.max(-100, Math.min(100, saturation)) / 100;
    const light = Math.max(-100, Math.min(100, lightness)) / 100;
    const h = (h0 + hue / 360 + 1) % 1;
    const s = Math.min(Math.max(s0 * sat, 0), 1);
    let [r, g, b] = hslToRgb(h, s, l);
    if (light > 0) [r, g, b] = [r + (255 - r) * light, g + (255 - g) * light, b + (255 - b) * light];
    else if (light < 0) [r, g, b] = [r * (1 + light), g * (1 + light), b * (1 + light)];
    pixels[i] = clamp(r);
    pixels[i + 1] = clamp(g);
    pixels[i + 2] = clamp(b);
  }
}

function vibrance(adj: Of<"vibrance">): (c: Float64Array) => void {
  const v = adj.vibrance / 100;
  const s = (adj.saturation ?? 0) / 100;
  return (c) => {
    const [mx, mn] = [Math.max(c[0]!, c[1]!, c[2]!), Math.min(c[0]!, c[1]!, c[2]!)];
    const sat = mx - mn;
    // Skin tones (orange hues, red the largest channel and green above blue) take half the boost.
    const skin = c[0] === mx && c[1]! >= c[2]! ? 0.5 : 1;
    const boost = v > 0 ? v * (1 - sat) ** 2 * skin : v * (1 - sat * 0.5);
    const l = lum(c);
    const k = (1 + boost) * (1 + s);
    for (let j = 0; j < 3; j++) c[j] = l + (c[j]! - l) * k;
  };
}

function colorBalance(adj: Of<"color-balance">): (c: Float64Array) => void {
  const ranges = [adj.shadows, adj.midtones, adj.highlights];
  const preserve = adj.preserveLuminosity ?? true;
  return (c) => {
    const before = lum(c);
    const l = (Math.max(c[0]!, c[1]!, c[2]!) + Math.min(c[0]!, c[1]!, c[2]!)) / 2;
    // How much each tonal range applies at this lightness.
    const weights = [1 - smooth(0, 0.5, l), 4 * l * (1 - l), smooth(0.5, 1, l)];
    for (let r = 0; r < 3; r++) {
      const shift = ranges[r];
      if (!shift) continue;
      for (let j = 0; j < 3; j++) c[j]! += (shift[j]! / 100) * weights[r]! * 0.5;
    }
    if (preserve) setLum(c, before);
  };
}
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

function blackWhite(adj: Of<"black-white">): (c: Float64Array) => void {
  // Photoshop's defaults: reds 40, yellows 60, greens 40, cyans 60, blues 20, magentas 80.
  const w = {
    r: (adj.reds ?? 40) / 100,
    y: (adj.yellows ?? 60) / 100,
    g: (adj.greens ?? 40) / 100,
    c: (adj.cyans ?? 60) / 100,
    b: (adj.blues ?? 20) / 100,
    m: (adj.magentas ?? 80) / 100,
  };
  const tint = adj.tint ? new Float64Array([1, 3, 5].map((k) => parseInt(adj.tint!.slice(k, k + 2), 16) / 255)) : undefined;
  return (c) => {
    const [r, g, b] = [c[0]!, c[1]!, c[2]!];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const mid = r + g + b - mx - mn;
    // The largest channel names the primary range (red, green, blue); the smallest, the secondary
    // between the other two (no blue: yellow; no red: cyan; no green: magenta).
    const primary = mx === r ? w.r : mx === g ? w.g : w.b;
    const secondary = mn === b ? w.y : mn === r ? w.c : w.m;
    const grey = clamp01(mn + (mid - mn) * secondary + (mx - mid) * primary);
    if (tint) {
      c.set(tint);
      setLum(c, grey);
    } else c.fill(grey);
  };
}

function photoFilter(adj: Of<"photo-filter">): (c: Float64Array) => void {
  const f = [1, 3, 5].map((k) => parseInt(adj.color.slice(k, k + 2), 16) / 255);
  const d = adj.density / 100;
  const preserve = adj.preserveLuminosity ?? true;
  return (c) => {
    const before = lum(c);
    for (let j = 0; j < 3; j++) c[j] = c[j]! + (c[j]! * f[j]! - c[j]!) * d;
    if (preserve) setLum(c, before);
  };
}

function channelMixer(adj: Of<"channel-mixer">): (c: Float64Array) => void {
  const mix = (m: readonly number[], c: Float64Array) => (c[0]! * m[0]! + c[1]! * m[1]! + c[2]! * m[2]!) / 100 + m[3]! / 100;
  const rows = [adj.red ?? [100, 0, 0, 0], adj.green ?? [0, 100, 0, 0], adj.blue ?? [0, 0, 100, 0]];
  return (c) => {
    if (adj.monochrome) return void c.fill(mix(adj.monochrome, c));
    const out = rows.map((m) => mix(m, c));
    c.set(out);
  };
}

/**
 * Selective Color: each pixel belongs to colour ranges by how strongly it shows them (red: how
 * far red exceeds the other two, whites: how far its darkest channel is above mid-grey…), and each
 * range shifts the cyan, magenta and yellow inks (the complements of red, green and blue) and black.
 */
function selectiveColor(adj: Of<"selective-color">): (c: Float64Array) => void {
  const relative = (adj.mode ?? "relative") === "relative";
  const ranges = (["reds", "yellows", "greens", "cyans", "blues", "magentas", "whites", "neutrals", "blacks"] as const).filter((r) => adj[r]);
  return (c) => {
    const [r, g, b] = [c[0]!, c[1]!, c[2]!];
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const mid = r + g + b - mx - mn;
    const amounts: Record<string, number> = {
      reds: mx === r ? mx - mid : 0,
      greens: mx === g ? mx - mid : 0,
      blues: mx === b ? mx - mid : 0,
      yellows: mn === b ? mid - mn : 0,
      cyans: mn === r ? mid - mn : 0,
      magentas: mn === g ? mid - mn : 0,
      whites: Math.max(0, mn - 0.5) * 2,
      blacks: Math.max(0, 0.5 - mx) * 2,
      neutrals: 1 - (Math.abs(mx - 0.5) + Math.abs(mn - 0.5)),
    };
    const out = [r, g, b];
    for (const range of ranges) {
      const amount = amounts[range]!;
      if (amount <= 0) continue;
      const [cy, ma, ye, k] = adj[range]!.map((v) => v / 100) as [number, number, number, number];
      [cy, ma, ye].forEach((shift, j) => {
        // More ink means less of the channel; relative scales by the ink already there.
        const ink = 1 - out[j]!;
        out[j] = out[j]! - amount * shift * (relative ? (shift > 0 ? ink : 1 - ink) : 1);
      });
      for (let j = 0; j < 3; j++) out[j] = k > 0 ? out[j]! * (1 - amount * k * (relative ? 1 - out[j]! * 0.5 : 1)) : out[j]! + (1 - out[j]!) * amount * -k;
    }
    c.set(out);
  };
}

/** Trilinear lookup of c (0..1) in a 3D LUT, in place. */
function lookup(lut: Lut3D, c: Float64Array): void {
  const n = lut.size;
  const idx = [0, 1, 2].map((j) => clamp01((c[j]! - lut.min[j]!) / (lut.max[j]! - lut.min[j]! || 1)) * (n - 1));
  const i0 = idx.map((v) => Math.min(n - 2, Math.floor(v)));
  const t = idx.map((v, j) => v - i0[j]!);
  const at = (ri: number, gi: number, bi: number, ch: number) => lut.data[((bi * n + gi) * n + ri) * 3 + ch]!;
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      const [dr, dg, db] = [k & 1, (k >> 1) & 1, (k >> 2) & 1];
      const wt = (dr ? t[0]! : 1 - t[0]!) * (dg ? t[1]! : 1 - t[1]!) * (db ? t[2]! : 1 - t[2]!);
      if (wt) v += wt * at(i0[0]! + dr, i0[1]! + dg, i0[2]! + db, ch);
    }
    out[ch] = v;
  }
  c.set(out);
}

/** Reads an Adobe/Resolve .cube 3D LUT. */
export function parseCube(text: string): Lut3D {
  let size = 0;
  let min: [number, number, number] = [0, 0, 0];
  let max: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === "LUT_3D_SIZE") size = Number(rest[0]);
    else if (key === "LUT_1D_SIZE") throw new Error("1D .cube LUTs aren't supported; use a 3D LUT");
    else if (key === "DOMAIN_MIN") min = rest.map(Number) as [number, number, number];
    else if (key === "DOMAIN_MAX") max = rest.map(Number) as [number, number, number];
    else if (/^[-+\d.]/.test(key!)) values.push(Number(key), ...rest.slice(0, 2).map(Number));
  }
  if (size < 2 || size > 256) throw new Error("Not a 3D .cube LUT (LUT_3D_SIZE missing or out of range)");
  if (values.length !== size ** 3 * 3 || values.some(Number.isNaN)) throw new Error(`The .cube LUT should have ${size ** 3} entries`);
  return { size, data: Float32Array.from(values), min, max };
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
