import { rgbToLab } from "./cpu.js";
import type { Rendered } from "./render.js";

// Measurements on rendered pixels, so an agent can check its work with numbers as well as by eye:
// Photoshop's Histogram and Info panels, the eyedropper, clipping warnings and a few retoucher's checks.

export type Region = { x: number; y: number; w: number; h: number };

/** Copies part of a render. The region is clamped to the image and rounded to whole pixels. */
export function cropRendered(r: Rendered, region: Region): Rendered {
  const x0 = Math.min(r.width - 1, Math.max(0, Math.round(region.x)));
  const y0 = Math.min(r.height - 1, Math.max(0, Math.round(region.y)));
  const w = Math.max(1, Math.min(r.width - x0, Math.round(region.w)));
  const h = Math.max(1, Math.min(r.height - y0, Math.round(region.h)));
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) pixels.set(r.pixels.subarray(((y0 + y) * r.width + x0) * 4, ((y0 + y) * r.width + x0 + w) * 4), y * w * 4);
  return { ...r, width: w, height: h, pixels };
}

/** Enlarges by a whole factor with every pixel as a square block, the way Photoshop shows 200% or 400%. */
export function zoomRendered(r: Rendered, factor: number): Rendered {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return r;
  const [w, h] = [r.width * f, r.height * f];
  const out = new Uint32Array(w * h);
  const src = new Uint32Array(r.pixels.buffer, r.pixels.byteOffset, r.width * r.height);
  for (let y = 0; y < h; y++) {
    const row = ((y / f) | 0) * r.width;
    for (let x = 0; x < w; x++) out[y * w + x] = src[row + ((x / f) | 0)]!;
  }
  return { ...r, width: w, height: h, pixels: new Uint8Array(out.buffer) };
}

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;
const percent = (part: number, whole: number) => round((100 * part) / Math.max(1, whole), 2);

/** Hue, saturation and brightness (0..360, 0..100, 0..100), as in the Color Picker. */
function hsb(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [Math.round((h * 60 + 360) % 360), Math.round(max ? (100 * d) / max : 0), Math.round((100 * max) / 255)];
}

/**
 * Where a colour falls on a vectorscope: the angle of its chroma (Cb, Cr) in degrees. Skin of every
 * complexion sits close to the skin-tone line at about 123°; retouchers check skin against it.
 */
export function vectorscopeAngle(r: number, g: number, b: number): number {
  const cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
  return round(((Math.atan2(cr, cb) * 180) / Math.PI + 360) % 360, 0);
}

export const SKIN_LINE = 123;

export type Sample = {
  at: [number, number];
  hex: string;
  rgb: [number, number, number];
  hsb: [number, number, number];
  lab: [number, number, number];
  alpha: number;
  /** Vectorscope angle, and how far it is from the skin-tone line (positive is towards red, negative towards yellow). */
  vectorscope: { angle: number; fromSkinLine: number };
};

/** The eyedropper: the colour at a point, averaged over a size × size square (1 = point sample). */
export function sampleAt(r: Rendered, at: [number, number], size = 1): Sample {
  const half = Math.floor(size / 2);
  const [cx, cy] = [Math.round(at[0]), Math.round(at[1])];
  let [sr, sg, sb, sa, n] = [0, 0, 0, 0, 0];
  for (let y = cy - half; y <= cy + half; y++) {
    for (let x = cx - half; x <= cx + half; x++) {
      if (x < 0 || y < 0 || x >= r.width || y >= r.height) continue;
      const i = (y * r.width + x) * 4;
      const a = r.pixels[i + 3]!;
      sr += r.pixels[i]! * a;
      sg += r.pixels[i + 1]! * a;
      sb += r.pixels[i + 2]! * a;
      sa += a;
      n++;
    }
  }
  if (!n) throw new Error(`Sample point [${at.join(", ")}] is outside the image (${r.width}×${r.height})`);
  const [R, G, B] = sa ? [sr / sa, sg / sa, sb / sa] : [0, 0, 0];
  const lab = new Float64Array(3);
  rgbToLab(R / 255, G / 255, B / 255, lab);
  const angle = vectorscopeAngle(R, G, B);
  let from = angle - SKIN_LINE;
  if (from > 180) from -= 360;
  if (from < -180) from += 360;
  return {
    at: [cx, cy],
    hex: hex(R, G, B),
    rgb: [Math.round(R), Math.round(G), Math.round(B)],
    hsb: hsb(R, G, B),
    lab: [round(lab[0]!), round(lab[1]!), round(lab[2]!)],
    alpha: round(sa / n / 255, 2),
    vectorscope: { angle, fromSkinLine: round(from, 0) },
  };
}

export type Stats = {
  size: [number, number];
  /** Share of pixels that aren't fully opaque, in %. Measurements weigh pixels by opacity. */
  transparent: number;
  luminance: {
    mean: number;
    median: number;
    /** Darkest and brightest tones after ignoring the extreme 0.5% at each end, 0..255. */
    range: [number, number];
    /** Spread of tones (standard deviation, 0..255): low is flat, above ~60 is contrasty. */
    contrast: number;
    /** Pixels at pure black / pure white in every channel, in %. */
    clipped: { shadows: number; highlights: number };
    /** 16 bins from black to white, each the % of pixels in it. */
    histogram: number[];
  };
  channels: Record<"red" | "green" | "blue", { mean: number; clippedLow: number; clippedHigh: number }>;
  color: {
    mean: string;
    lab: [number, number, number];
    /** The average colour's direction, read from Lab a* and b*: "neutral", or e.g. "warm, slightly magenta". */
    cast: string;
    /** Mean and 99th-percentile chroma (Lab C*): above ~60 at the top end is very saturated. */
    chroma: { mean: number; p99: number };
  };
  /** Fine-detail energy (variance of the Laplacian of luminance): higher is sharper; compare like with like. */
  sharpness: number;
  /** Estimated noise or grain, 0..255 (from the finest detail in smooth areas). */
  noise: number;
};

/** Histogram, clipping, colour cast, chroma, sharpness and noise of a render or part of one. */
export function measure(r: Rendered): Stats {
  const { width: w, height: h, pixels: p } = r;
  const n = w * h;
  const lum = new Float32Array(n);
  const weight = new Float32Array(n);
  const bins = new Float64Array(256);
  const chroma: number[] = [];
  const lab = new Float64Array(3);
  let [total, transparent, sumL, sumL2, shadows, highlights, sr, sg, sb, sumC] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const clip = { red: [0, 0], green: [0, 0], blue: [0, 0] };
  // Chroma is measured on a grid of at most ~250k pixels; it's an average, not a per-pixel figure.
  const step = Math.max(1, Math.floor(Math.sqrt(n / 250_000)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const [R, G, B, A] = [p[i * 4]!, p[i * 4 + 1]!, p[i * 4 + 2]!, p[i * 4 + 3]! / 255];
      if (A < 1) transparent++;
      weight[i] = A;
      const L = 0.299 * R + 0.587 * G + 0.114 * B;
      lum[i] = L;
      if (!A) continue;
      total += A;
      sumL += L * A;
      sumL2 += L * L * A;
      bins[Math.round(L)]! += A;
      sr += R * A;
      sg += G * A;
      sb += B * A;
      if (R === 0 && G === 0 && B === 0) shadows += A;
      if (R === 255 && G === 255 && B === 255) highlights += A;
      if (R === 0) clip.red[0]! += A;
      if (R === 255) clip.red[1]! += A;
      if (G === 0) clip.green[0]! += A;
      if (G === 255) clip.green[1]! += A;
      if (B === 0) clip.blue[0]! += A;
      if (B === 255) clip.blue[1]! += A;
      if (x % step === 0 && y % step === 0 && A > 0.5) {
        rgbToLab(R / 255, G / 255, B / 255, lab);
        const c = Math.hypot(lab[1]!, lab[2]!);
        chroma.push(c);
        sumC += c;
      }
    }
  }
  const quantile = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += bins[v]!;
      if (acc >= q * total) return v;
    }
    return 255;
  };
  const hist16 = Array.from({ length: 16 }, (_, k) => {
    let s = 0;
    for (let v = k * 16; v < k * 16 + 16; v++) s += bins[v]!;
    return round((100 * s) / Math.max(1e-9, total), 1);
  });
  const mean = total ? sumL / total : 0;
  const [mr, mg, mb] = total ? [sr / total, sg / total, sb / total] : [0, 0, 0];
  rgbToLab(mr / 255, mg / 255, mb / 255, lab);
  chroma.sort((a, b) => a - b);

  // Sharpness: Laplacian variance. Noise: median absolute Laplacian over the smoothest quarter of 8×8 blocks.
  let [lapSum, lapSum2, lapN] = [0, 0, 0];
  const blocks: number[] = [];
  const lap = (x: number, y: number) => 4 * lum[y * w + x]! - lum[y * w + x - 1]! - lum[y * w + x + 1]! - lum[(y - 1) * w + x]! - lum[(y + 1) * w + x]!;
  for (let by = 1; by + 8 < h; by += 8) {
    for (let bx = 1; bx + 8 < w; bx += 8) {
      let [blockAbs, opaque] = [0, true];
      for (let y = by; y < by + 8; y++) {
        for (let x = bx; x < bx + 8; x++) {
          if (weight[y * w + x]! < 1) opaque = false;
          const v = lap(x, y);
          lapSum += v;
          lapSum2 += v * v;
          lapN++;
          blockAbs += Math.abs(v);
        }
      }
      if (opaque) blocks.push(blockAbs / 64);
    }
  }
  blocks.sort((a, b) => a - b);
  const smooth = blocks.slice(0, Math.max(1, Math.floor(blocks.length / 4)));
  // For Gaussian noise of σ, the mean |Laplacian| is about 3.6σ.
  const noise = smooth.length ? smooth.reduce((s, v) => s + v, 0) / smooth.length / 3.6 : 0;

  return {
    size: [w, h],
    transparent: percent(transparent, n),
    luminance: {
      mean: round(mean),
      median: quantile(0.5),
      range: [quantile(0.005), quantile(0.995)],
      contrast: round(Math.sqrt(Math.max(0, (total ? sumL2 / total : 0) - mean * mean))),
      clipped: { shadows: percent(shadows, total), highlights: percent(highlights, total) },
      histogram: hist16,
    },
    channels: {
      red: { mean: round(mr), clippedLow: percent(clip.red[0]!, total), clippedHigh: percent(clip.red[1]!, total) },
      green: { mean: round(mg), clippedLow: percent(clip.green[0]!, total), clippedHigh: percent(clip.green[1]!, total) },
      blue: { mean: round(mb), clippedLow: percent(clip.blue[0]!, total), clippedHigh: percent(clip.blue[1]!, total) },
    },
    color: {
      mean: hex(mr, mg, mb),
      lab: [round(lab[0]!), round(lab[1]!), round(lab[2]!)],
      cast: cast(lab[1]!, lab[2]!),
      chroma: { mean: round(chroma.length ? sumC / chroma.length : 0), p99: round(chroma[Math.floor(chroma.length * 0.99)] ?? 0) },
    },
    sharpness: round(lapN ? lapSum2 / lapN - (lapSum / lapN) ** 2 : 0),
    noise: round(noise, 2),
  };
}

/** Names the direction of an average colour from its a* (green–magenta) and b* (blue–yellow). */
function cast(a: number, b: number): string {
  const word = (v: number, pos: string, neg: string) => {
    const m = Math.abs(v);
    if (m < 2) return "";
    return `${m < 5 ? "slightly " : m > 12 ? "strongly " : ""}${v > 0 ? pos : neg}`;
  };
  const parts = [word(b, "warm", "cool"), word(a, "magenta", "green")].filter(Boolean);
  return parts.length ? parts.join(", ") : "neutral";
}

/**
 * Photoshop's clipping display: the image in grey, with pixels clipped to white in any channel in red
 * and pixels clipped to black in any channel in blue.
 */
export function clippingMap(r: Rendered): Rendered {
  const out = new Uint8Array(r.pixels.length);
  for (let i = 0; i < r.width * r.height; i++) {
    const [R, G, B] = [r.pixels[i * 4]!, r.pixels[i * 4 + 1]!, r.pixels[i * 4 + 2]!];
    const g = Math.round((0.299 * R + 0.587 * G + 0.114 * B) * 0.6 + 50);
    const high = R === 255 || G === 255 || B === 255;
    const low = R === 0 || G === 0 || B === 0;
    out.set(high ? [255, 0, 0, 255] : low ? [0, 90, 255, 255] : [g, g, g, 255], i * 4);
  }
  return { ...r, pixels: out };
}

/** Where the detail is: local fine-detail energy, dark (soft) to bright (sharp). For focus, halos and over-smoothing. */
export function sharpnessMap(r: Rendered): Rendered {
  const { width: w, height: h, pixels: p } = r;
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) lum[i] = 0.299 * p[i * 4]! + 0.587 * p[i * 4 + 1]! + 0.114 * p[i * 4 + 2]!;
  const energy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      energy[i] = Math.abs(4 * lum[i]! - lum[i - 1]! - lum[i + 1]! - lum[i - w]! - lum[i + w]!);
    }
  }
  // A 5×5 box average turns per-pixel edges into areas, then a log scale shows soft and sharp areas alike.
  const radius = 2;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let [s, n] = [0, 0];
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          s += energy[yy * w + xx]!;
          n++;
        }
      }
      const v = Math.min(255, Math.round(Math.log1p(s / n) * 46));
      out.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { ...r, pixels: out };
}

export type Difference = {
  /** Pixels that changed by more than 2 levels in any channel, in %. */
  changed: number;
  /** Average and largest colour difference (CIE76 ΔE) over the changed pixels. */
  deltaE: { mean: number; max: number };
  /** The box around everything that changed, in the images' pixels; absent when nothing did. */
  bounds?: Region;
};

/** How two renders of the same size differ, with an image of it: unchanged areas dark, changes bright. */
export function difference(before: Rendered, after: Rendered, amplify = 4): { stats: Difference; image: Rendered } {
  if (before.width !== after.width || before.height !== after.height) throw new Error("Compared renders must be the same size");
  const { width: w, height: h } = after;
  const out = new Uint8Array(w * h * 4);
  const [l1, l2] = [new Float64Array(3), new Float64Array(3)];
  let [changed, sumE, maxE] = [0, 0, 0];
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(before.pixels[i + c]! - after.pixels[i + c]!));
      const v = Math.min(255, d * amplify);
      out.set([v, v, v, 255], i);
      if (d <= 2) continue;
      changed++;
      rgbToLab(before.pixels[i]! / 255, before.pixels[i + 1]! / 255, before.pixels[i + 2]! / 255, l1);
      rgbToLab(after.pixels[i]! / 255, after.pixels[i + 1]! / 255, after.pixels[i + 2]! / 255, l2);
      const e = Math.hypot(l1[0]! - l2[0]!, l1[1]! - l2[1]!, l1[2]! - l2[2]!);
      sumE += e;
      maxE = Math.max(maxE, e);
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  const stats: Difference = {
    changed: percent(changed, w * h),
    deltaE: { mean: round(changed ? sumE / changed : 0), max: round(maxE) },
    ...(x1 >= 0 ? { bounds: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } } : {}),
  };
  return { stats, image: { ...after, pixels: out } };
}

/** Two renders side by side with a gap, before on the left. */
export function sideBySide(before: Rendered, after: Rendered, gap = 6): Rendered {
  const w = before.width + gap + after.width;
  const h = Math.max(before.height, after.height);
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set([128, 128, 128, 255], i * 4);
  const put = (r: Rendered, ox: number) => {
    for (let y = 0; y < r.height; y++) out.set(r.pixels.subarray(y * r.width * 4, (y + 1) * r.width * 4), (y * w + ox) * 4);
  };
  put(before, 0);
  put(after, before.width + gap);
  return { ...after, width: w, height: h, pixels: out };
}
