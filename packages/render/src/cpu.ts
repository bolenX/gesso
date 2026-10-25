import type { CanvasKit, Image } from "canvaskit-wasm";

// Pixel work on the CPU. CanvasKit runs runtime shaders through its software pipeline here,
// at roughly 0.2 µs per sample per pixel, so a 25-tap shader on a large poster takes seconds;
// plain loops over typed arrays are an order of magnitude faster, and the algorithms below
// (sliding windows, prefix sums, separable passes) don't grow with the radius.

/** Premultiplied RGBA, 0..255 per channel, row-major. */
export type Raster = { w: number; h: number; d: Float32Array };

export function readRaster(ck: CanvasKit, image: Image, consume = true): Raster {
  const [w, h] = [image.width(), image.height()];
  const bytes = image.readPixels(0, 0, { width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB }) as Uint8Array;
  if (consume) image.delete();
  return { w, h, d: new Float32Array(bytes) };
}

export function writeRaster(ck: CanvasKit, r: Raster): Image {
  // The clamped array rounds and clamps natively; colour then may not exceed alpha (premultiplied).
  const out = new Uint8ClampedArray(r.d);
  for (let i = 0; i < out.length; i += 4) {
    const a = out[i + 3]!;
    if (out[i]! > a) out[i] = a;
    if (out[i + 1]! > a) out[i + 1] = a;
    if (out[i + 2]! > a) out[i + 2] = a;
  }
  return ck.MakeImage({ width: r.w, height: r.h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB }, new Uint8Array(out.buffer), r.w * 4)!;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
/** Length of (x, y); Math.hypot is several times slower in hot loops. */
export const len = (x: number, y: number) => Math.sqrt(x * x + y * y);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a || 1), 0, 1);
  return t * t * (3 - 2 * t);
};
export const blank = (r: Raster): Raster => ({ w: r.w, h: r.h, d: new Float32Array(r.d.length) });
export const copyRaster = (r: Raster): Raster => ({ w: r.w, h: r.h, d: r.d.slice() });

/**
 * Straight (unpremultiplied) colour work: calls fn with each pixel's colour in 0..1 (rgb, edited
 * in place) and its index, keeping alpha. Pixels with no alpha are skipped.
 */
export function mapColor(r: Raster, fn: (rgb: Float64Array, i: number) => void): Raster {
  const out = blank(r);
  const rgb = new Float64Array(3);
  const { d } = r;
  for (let i = 0, n = 0; i < d.length; i += 4, n++) {
    const a = d[i + 3]!;
    out.d[i + 3] = a;
    if (a <= 0) continue;
    rgb[0] = d[i]! / a;
    rgb[1] = d[i + 1]! / a;
    rgb[2] = d[i + 2]! / a;
    fn(rgb, n);
    out.d[i] = clamp(rgb[0], 0, 1) * a;
    out.d[i + 1] = clamp(rgb[1], 0, 1) * a;
    out.d[i + 2] = clamp(rgb[2], 0, 1) * a;
  }
  return out;
}

/** Straight colour planes in 0..1 (one per channel) and alpha in 0..255. */
export function planes(r: Raster): { rgb: [Float32Array, Float32Array, Float32Array]; a: Float32Array } {
  const n = r.w * r.h;
  const rgb: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const al = r.d[i * 4 + 3]!;
    a[i] = al;
    if (al <= 0) continue;
    for (let c = 0; c < 3; c++) rgb[c]![i] = r.d[i * 4 + c]! / al;
  }
  return { rgb, a };
}

export function fromPlanes(w: number, h: number, rgb: ArrayLike<number>[], a: Float32Array): Raster {
  const d = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const al = a[i]!;
    d[i * 4 + 3] = al;
    for (let c = 0; c < 3; c++) d[i * 4 + c] = clamp(rgb[c]![i]!, 0, 1) * al;
  }
  return { w, h, d };
}

/** Rec. 601 luma of straight colour planes, 0..1. */
export function luma(rgb: ArrayLike<number>[], n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = rgb[0]![i]! * 0.299 + rgb[1]![i]! * 0.587 + rgb[2]![i]! * 0.114;
  return out;
}

// ── Sampling ─────────────────────────────────────────────────────────────────────────────

/** Bilinear sample at (x, y) in pixel units (pixel centres at +0.5), edges repeating; writes 4 channels at out[o]. */
export function sample(r: Raster, x: number, y: number, out: Float32Array, o: number): void {
  const { w, h, d } = r;
  const fx = clamp(x - 0.5, 0, w - 1);
  const fy = clamp(y - 0.5, 0, h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const a = (y0 * w + x0) * 4;
  const b = (y0 * w + x1) * 4;
  const c = (y1 * w + x0) * 4;
  const e = (y1 * w + x1) * 4;
  for (let k = 0; k < 4; k++) {
    const top = d[a + k]! + (d[b + k]! - d[a + k]!) * tx;
    const bottom = d[c + k]! + (d[e + k]! - d[c + k]!) * tx;
    out[o + k] = top + (bottom - top) * ty;
  }
}

/** Bilinear sample of a single-channel plane, edges repeating. */
export function samplePlane(p: ArrayLike<number>, w: number, h: number, x: number, y: number): number {
  const fx = clamp(x - 0.5, 0, w - 1);
  const fy = clamp(y - 0.5, 0, h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = x0 + 1 < w ? x0 + 1 : x0;
  const y1 = y0 + 1 < h ? y0 + 1 : y0;
  const tx = fx - x0;
  const ty = fy - y0;
  const top = p[y0 * w + x0]! + (p[y0 * w + x1]! - p[y0 * w + x0]!) * tx;
  const bottom = p[y1 * w + x0]! + (p[y1 * w + x1]! - p[y1 * w + x0]!) * tx;
  return top + (bottom - top) * ty;
}

/** Resamples by a map from each output pixel centre to the source point it shows. */
export function remap(src: Raster, map: (x: number, y: number, to: Float64Array) => void): Raster {
  const out = blank(src);
  const to = new Float64Array(2);
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      to[0] = x + 0.5;
      to[1] = y + 0.5;
      map(x + 0.5, y + 0.5, to);
      sample(src, to[0], to[1], out.d, (y * src.w + x) * 4);
    }
  return out;
}

/** Averages f×f blocks (f a whole number); edge blocks average what they cover. */
export function shrink(r: Raster, f: number): Raster {
  if (f <= 1) return r;
  const [w, h] = [Math.ceil(r.w / f), Math.ceil(r.h / f)];
  const d = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0;
      const o = (y * w + x) * 4;
      for (let yy = y * f; yy < Math.min(r.h, (y + 1) * f); yy++)
        for (let xx = x * f; xx < Math.min(r.w, (x + 1) * f); xx++) {
          const i = (yy * r.w + xx) * 4;
          for (let c = 0; c < 4; c++) d[o + c]! += r.d[i + c]!;
          n++;
        }
      for (let c = 0; c < 4; c++) d[o + c]! /= n;
    }
  return { w, h, d };
}

/** Bilinear upscale of a raster shrunk by f back to w×h. */
export function grow(r: Raster, f: number, w: number, h: number): Raster {
  if (f <= 1 && r.w === w && r.h === h) return r;
  const out = { w, h, d: new Float32Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sample(r, (x + 0.5) / f, (y + 0.5) / f, out.d, (y * w + x) * 4);
  return out;
}

/** Runs fn at 1/f resolution (f rounded up to a whole number), returning a full-size result. */
export function reduced(r: Raster, f: number, fn: (small: Raster, f: number) => Raster): Raster {
  const k = Math.max(1, Math.ceil(f - 0.001));
  if (k === 1) return fn(r, 1);
  return grow(fn(shrink(r, k), k), k, r.w, r.h);
}

// ── Blurs ────────────────────────────────────────────────────────────────────────────────

/**
 * Window sums along rows: each output averages src over [x-before, x+after] (edges repeating),
 * plus `frac` of the next sample on each side. `ch` channels are interleaved.
 */
function windowH(src: Float32Array, w: number, h: number, ch: number, before: number, after: number, frac = 0): Float32Array {
  const out = new Float32Array(src.length);
  const norm = 1 / (before + after + 1 + 2 * frac);
  const sums = new Float64Array(ch);
  const rowLen = w * ch;
  for (let y = 0; y < h; y++) {
    const base = y * rowLen;
    for (let c = 0; c < ch; c++) {
      let s = 0;
      for (let j = -before; j <= after; j++) s += src[base + (j < 0 ? 0 : j >= w ? w - 1 : j) * ch + c]!;
      sums[c] = s;
    }
    for (let x = 0; x < w; x++) {
      const [xin, xout] = [x + after + 1, x - before];
      const iin = base + (xin >= w ? w - 1 : xin) * ch;
      const iout = base + (xout < 0 ? 0 : xout) * ch;
      const o = base + x * ch;
      if (frac > 0) {
        const il = base + (xout - 1 < 0 ? 0 : xout - 1) * ch;
        for (let c = 0; c < ch; c++) {
          out[o + c] = (sums[c]! + (src[il + c]! + src[iin + c]!) * frac) * norm;
          sums[c]! += src[iin + c]! - src[iout + c]!;
        }
      } else
        for (let c = 0; c < ch; c++) {
          out[o + c] = sums[c]! * norm;
          sums[c]! += src[iin + c]! - src[iout + c]!;
        }
    }
  }
  return out;
}

/** windowH's counterpart down columns, kept in row order (one running sum per column) for the cache. */
function windowV(src: Float32Array, w: number, h: number, ch: number, before: number, after: number, frac = 0): Float32Array {
  const out = new Float32Array(src.length);
  const norm = 1 / (before + after + 1 + 2 * frac);
  const rowLen = w * ch;
  const sums = new Float64Array(rowLen);
  for (let j = -before; j <= after; j++) {
    const row = (j < 0 ? 0 : j >= h ? h - 1 : j) * rowLen;
    for (let k = 0; k < rowLen; k++) sums[k]! += src[row + k]!;
  }
  for (let y = 0; y < h; y++) {
    const o = y * rowLen;
    const rin = Math.min(h - 1, y + after + 1) * rowLen;
    const rout = Math.max(0, y - before) * rowLen;
    if (frac > 0) {
      const rl = Math.max(0, y - before - 1) * rowLen;
      for (let k = 0; k < rowLen; k++) {
        out[o + k] = (sums[k]! + (src[rl + k]! + src[rin + k]!) * frac) * norm;
        sums[k]! += src[rin + k]! - src[rout + k]!;
      }
    } else
      for (let k = 0; k < rowLen; k++) {
        out[o + k] = sums[k]! * norm;
        sums[k]! += src[rin + k]! - src[rout + k]!;
      }
  }
  return out;
}

/** A symmetric box of radius r (fractional radii weight the end samples). */
function box(src: Float32Array, w: number, h: number, ch: number, rx: number, ry: number): Float32Array {
  const [ix, iy] = [Math.floor(rx), Math.floor(ry)];
  return windowV(windowH(src, w, h, ch, ix, ix, rx - ix), w, h, ch, iy, iy, ry - iy);
}

/** A 1-D kernel (offsets and weights) along rows, then down columns, edges repeating. */
function separable(src: Float32Array, w: number, h: number, ch: number, offsets: Int32Array, weights: Float32Array): Float32Array {
  const tmp = new Float32Array(src.length);
  const rowLen = w * ch;
  const R = Math.max(...offsets.map(Math.abs));
  const taps = offsets.length;
  const steps = offsets.map((o) => o * ch);
  for (let y = 0; y < h; y++) {
    const base = y * rowLen;
    for (let x = 0; x < w; x++) {
      const o = base + x * ch;
      if (x >= R && x < w - R)
        for (let c = 0; c < ch; c++) {
          let s = 0;
          for (let t = 0; t < taps; t++) s += src[o + steps[t]! + c]! * weights[t]!;
          tmp[o + c] = s;
        }
      else
        for (let c = 0; c < ch; c++) {
          let s = 0;
          for (let t = 0; t < taps; t++) {
            const xx = x + offsets[t]!;
            s += src[base + (xx < 0 ? 0 : xx >= w ? w - 1 : xx) * ch + c]! * weights[t]!;
          }
          tmp[o + c] = s;
        }
    }
  }
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    const o = y * rowLen;
    for (let t = 0; t < offsets.length; t++) {
      const yy = y + offsets[t]!;
      const row = (yy < 0 ? 0 : yy >= h ? h - 1 : yy) * rowLen;
      const wt = weights[t]!;
      for (let k = 0; k < rowLen; k++) out[o + k]! += tmp[row + k]! * wt;
    }
  }
  return out;
}

/** Box blur of a single-channel plane. */
export function boxPlane(p: Float32Array, w: number, h: number, rx: number, ry = rx): Float32Array {
  return box(p, w, h, 1, rx, ry);
}

/** Box blur of all four channels. */
export function boxBlur(r: Raster, rx: number, ry = rx): Raster {
  return { w: r.w, h: r.h, d: box(r.d, r.w, r.h, 4, rx, ry) };
}

/** Gaussian blur (sigma in pixels): a direct kernel for small sigmas, three box passes for large ones. */
export function gaussBlur(r: Raster, sigma: number): Raster {
  if (sigma < 0.2) return copyRaster(r);
  if (sigma >= 2) {
    // Box radii whose three passes match the Gaussian's variance.
    const rr = Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5;
    return boxBlur(boxBlur(boxBlur(r, rr), rr), rr);
  }
  const R = Math.ceil(sigma * 3);
  const offsets = Int32Array.from({ length: 2 * R + 1 }, (_, i) => i - R);
  const weights = Float32Array.from(offsets, (o) => Math.exp(-(o * o) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) weights[i]! /= total;
  return { w: r.w, h: r.h, d: separable(r.d, r.w, r.h, 4, offsets, weights) };
}

/** A flat disc (lens) blur of radius r pixels: each output sums row spans from per-row prefix sums. */
export function discBlur(r: Raster, radius: number): Raster {
  const { w, h, d } = r;
  const R = Math.max(1, Math.round(radius));
  const prefix = new Float32Array((w + 1) * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < 4; c++) prefix[(y * (w + 1) + x + 1) * 4 + c] = prefix[(y * (w + 1) + x) * 4 + c]! + d[(y * w + x) * 4 + c]!;
  const spans = Array.from({ length: 2 * R + 1 }, (_, j) => Math.floor(Math.sqrt(R * R - (j - R) ** 2)));
  const count = spans.reduce((a, s) => a + 2 * s + 1, 0);
  const out = blank(r);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let j = 0; j < spans.length; j++) {
        const yy = clamp(y + j - R, 0, h - 1);
        const s = spans[j]!;
        const [lo, hi] = [x - s, x + s];
        const [l, rr] = [Math.max(0, lo), Math.min(w - 1, hi)];
        const row = yy * (w + 1);
        for (let c = 0; c < 4; c++) {
          let v = prefix[(row + rr + 1) * 4 + c]! - prefix[(row + l) * 4 + c]!;
          if (lo < 0) v += -lo * d[(yy * w) * 4 + c]!;
          if (hi > w - 1) v += (hi - w + 1) * d[(yy * w + w - 1) * 4 + c]!;
          out.d[o + c]! += v;
        }
      }
      for (let c = 0; c < 4; c++) out.d[o + c]! /= count;
    }
  return out;
}

/**
 * Edge-preserving smoothing (the guided filter, guided by the image itself): flat areas average
 * over the radius; detail whose spread exceeds sqrt(eps) (in 0..1 units) is kept.
 */
export function guided(r: Raster, radius: number, eps: number): Raster {
  const { w, h } = r;
  const n = w * h;
  const out = blank(r);
  for (let c = 0; c < 4; c++) {
    const I = new Float32Array(n);
    const II = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const v = r.d[i * 4 + c]! / 255;
      I[i] = v;
      II[i] = v * v;
    }
    const mI = boxPlane(I, w, h, radius);
    const mII = boxPlane(II, w, h, radius);
    const A = new Float32Array(n);
    const B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const variance = Math.max(0, mII[i]! - mI[i]! * mI[i]!);
      const a = variance / (variance + eps);
      A[i] = a;
      B[i] = mI[i]! * (1 - a);
    }
    const mA = boxPlane(A, w, h, radius);
    const mB = boxPlane(B, w, h, radius);
    for (let i = 0; i < n; i++) out.d[i * 4 + c] = (mA[i]! * I[i]! + mB[i]!) * 255;
  }
  return out;
}

/** Mean of each pixel's trailing (r+1)² window, [x-r..x]×[y-r..y], edges repeating. */
function trailing(p: Float32Array, w: number, h: number, r: number): Float32Array {
  return windowV(windowH(p, w, h, 1, r, 0), w, h, 1, r, 0);
}

/**
 * Kuwahara painterly smoothing: each pixel takes the mean colour of whichever of its four
 * (r+1)² quadrants varies least, so strokes stay crisp at their edges.
 */
export function kuwahara(r: Raster, radius: number): Raster {
  const { w, h } = r;
  const R = Math.max(1, Math.round(radius));
  const n = w * h;
  const { rgb, a } = planes(r);
  const means = rgb.map((p) => trailing(p, w, h, R));
  const variance = new Float32Array(n);
  for (let c = 0; c < 3; c++) {
    const sq = new Float32Array(n);
    for (let i = 0; i < n; i++) sq[i] = rgb[c]![i]! * rgb[c]![i]!;
    const msq = trailing(sq, w, h, R);
    for (let i = 0; i < n; i++) variance[i]! += msq[i]! - means[c]![i]! * means[c]![i]!;
  }
  const out: Float32Array[] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let best = Infinity;
      let pick = 0;
      for (const [qx, qy] of [[x, y], [x + R, y], [x, y + R], [x + R, y + R]] as const) {
        const i = clamp(qy, 0, h - 1) * w + clamp(qx, 0, w - 1);
        if (variance[i]! < best) {
          best = variance[i]!;
          pick = i;
        }
      }
      for (let c = 0; c < 3; c++) out[c]![y * w + x] = means[c]![pick]!;
    }
  return fromPlanes(w, h, out, a);
}

/** Maximum (grow) or minimum (shrink) over a square of radius r, in O(1) per pixel (van Herk / Gil-Werman). */
export function morph(r: Raster, radius: number, max: boolean): Raster {
  const { w, h } = r;
  const R = Math.max(1, Math.round(radius));
  const pick = max ? Math.max : Math.min;
  const tmp = new Float32Array(r.d.length);
  const out = new Float32Array(r.d.length);
  const line = (src: Float32Array, dst: Float32Array, start: number, stride: number, n: number) => {
    const k = 2 * R + 1;
    const len = n + 2 * R;
    const padded = new Float32Array(len);
    for (let i = 0; i < len; i++) padded[i] = src[start + clamp(i - R, 0, n - 1) * stride]!;
    const g = new Float32Array(len);
    const hh = new Float32Array(len);
    for (let i = 0; i < len; i++) g[i] = i % k === 0 ? padded[i]! : pick(g[i - 1]!, padded[i]!);
    for (let i = len - 1; i >= 0; i--) hh[i] = i === len - 1 || (i + 1) % k === 0 ? padded[i]! : pick(hh[i + 1]!, padded[i]!);
    for (let i = 0; i < n; i++) dst[start + i * stride] = pick(hh[i]!, g[i + 2 * R]!);
  };
  for (let c = 0; c < 4; c++) {
    for (let y = 0; y < h; y++) line(r.d, tmp, y * w * 4 + c, 4, w);
    for (let x = 0; x < w; x++) line(tmp, out, x * 4 + c, w * 4, h);
  }
  return { w, h, d: out };
}

/** Per-channel median over a (2r+1)² window of straight 8-bit RGBA, with a sliding histogram per row (Huang). */
export function median(px: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(px);
  const hist = new Int32Array(256);
  const target = Math.floor(((2 * r + 1) * (2 * r + 1)) / 2);
  const rows = new Int32Array(2 * r + 1);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      hist.fill(0);
      for (let k = 0; k < rows.length; k++) rows[k] = clamp(y - r + k, 0, h - 1) * w;
      // The median v is tracked with `below`, the count of window values under it, so each step only adjusts it.
      let [v, below] = [0, 0];
      const add = (xx: number, d: number) => {
        const x = xx < 0 ? 0 : xx >= w ? w - 1 : xx;
        for (let k = 0; k < rows.length; k++) {
          const q = px[(rows[k]! + x) * 4 + c]!;
          hist[q]! += d;
          if (q < v) below += d;
        }
      };
      for (let xx = -r; xx <= r; xx++) add(xx, 1);
      for (let x = 0; x < w; x++) {
        while (below > target) below -= hist[--v]!;
        while (below + hist[v]! <= target) below += hist[v++]!;
        out[(y * w + x) * 4 + c] = v;
        add(x - r, -1);
        add(x + r + 1, 1);
      }
    }
  }
  return out;
}

// ── Colour spaces ────────────────────────────────────────────────────────────────────────

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);
const labF = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const labInv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

/** sRGB (0..1) to CIE Lab (D65), written into out. */
export function rgbToLab(r: number, g: number, b: number, out: Float64Array): void {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const x = (0.4124 * lr + 0.3576 * lg + 0.1805 * lb) / 0.95047;
  const y = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  const z = (0.0193 * lr + 0.1192 * lg + 0.9505 * lb) / 1.08883;
  const [fx, fy, fz] = [labF(x), labF(y), labF(z)];
  out[0] = 116 * fy - 16;
  out[1] = 500 * (fx - fy);
  out[2] = 200 * (fy - fz);
}

/** CIE Lab (D65) to sRGB (0..1, unclamped), written into out. */
export function labToRgb(L: number, a: number, b: number, out: Float64Array): void {
  const fy = (L + 16) / 116;
  const [x, y, z] = [labInv(fy + a / 500) * 0.95047, labInv(fy), labInv(fy - b / 200) * 1.08883];
  out[0] = toSrgb(3.2406 * x - 1.5372 * y - 0.4986 * z);
  out[1] = toSrgb(-0.9689 * x + 1.8758 * y + 0.0415 * z);
  out[2] = toSrgb(0.0557 * x - 0.204 * y + 1.057 * z);
}

/** Shifts a colour (0..1, in place) by hue (degrees) and saturation and lightness (−100..100), like Hue/Saturation. */
export function shiftHsl(c: Float64Array, hue: number, saturation: number, lightness: number): void {
  const [r, g, b] = [c[0]!, c[1]!, c[2]!];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  let h = 0;
  let s = 0;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = (mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  h = (h + hue / 360 + 1) % 1;
  s = clamp(s * (1 + saturation / 100), 0, 1);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const ch = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  const out = s === 0 ? [l, l, l] : [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)];
  const k = lightness / 100;
  for (let j = 0; j < 3; j++) c[j] = k > 0 ? out[j]! + (1 - out[j]!) * k : out[j]! * (1 + k);
}

// ── Noise ────────────────────────────────────────────────────────────────────────────────

/** A deterministic hash of integer lattice coordinates to [0, 1). */
export function hash(x: number, y: number, seed = 0): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
export function valueNoise(x: number, y: number, seed = 0): number {
  const [ix, iy] = [Math.floor(x), Math.floor(y)];
  const [fx, fy] = [x - ix, y - iy];
  const [u, v] = [fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)];
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal (fBm) value noise in [0, 1], `octaves` layers each twice as fine. */
export function fbm(x: number, y: number, octaves: number, seed = 0): number {
  let [sum, amp, norm] = [0, 0.5, 0];
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x, y, seed + o * 31) * amp;
    norm += amp;
    x *= 2.03;
    y *= 2.03;
    amp *= 0.5;
  }
  return sum / norm;
}
