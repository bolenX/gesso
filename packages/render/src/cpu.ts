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
  return { w, h, d: Float32Array.from(bytes) };
}

export function writeRaster(ck: CanvasKit, r: Raster): Image {
  const { d } = r;
  const out = new Uint8Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = Math.round(clamp(d[i + 3]!, 0, 255));
    out[i + 3] = a;
    out[i] = Math.round(clamp(d[i]!, 0, a));
    out[i + 1] = Math.round(clamp(d[i + 1]!, 0, a));
    out[i + 2] = Math.round(clamp(d[i + 2]!, 0, a));
  }
  return ck.MakeImage({ width: r.w, height: r.h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB }, out, r.w * 4)!;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
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

/** One box pass along a line of n values (stride apart), edges repeating; radius r ≥ 0 may be fractional. */
function boxLine(src: Float32Array, dst: Float32Array, start: number, stride: number, n: number, r: number): void {
  const ri = Math.floor(r);
  const frac = r - ri;
  const at = (i: number) => src[start + clamp(i, 0, n - 1) * stride]!;
  const norm = 1 / (2 * r + 1);
  let sum = 0;
  for (let i = -ri; i <= ri; i++) sum += at(i);
  for (let i = 0; i < n; i++) {
    const edge = frac > 0 ? (at(i - ri - 1) + at(i + ri + 1)) * frac : 0;
    dst[start + i * stride] = (sum + edge) * norm;
    sum += at(i + ri + 1) - at(i - ri);
  }
}

/** Box blur of a single-channel plane. */
export function boxPlane(p: Float32Array, w: number, h: number, rx: number, ry = rx): Float32Array {
  const tmp = new Float32Array(p.length);
  const out = new Float32Array(p.length);
  for (let y = 0; y < h; y++) boxLine(p, tmp, y * w, 1, w, rx);
  for (let x = 0; x < w; x++) boxLine(tmp, out, x, w, h, ry);
  return out;
}

/** Box blur of all four channels. */
export function boxBlur(r: Raster, rx: number, ry = rx): Raster {
  const { w, h } = r;
  const tmp = new Float32Array(r.d.length);
  const out = new Float32Array(r.d.length);
  for (let c = 0; c < 4; c++) {
    for (let y = 0; y < h; y++) boxLine(r.d, tmp, y * w * 4 + c, 4, w, rx);
    for (let x = 0; x < w; x++) boxLine(tmp, out, x * 4 + c, w * 4, h, ry);
  }
  return { w, h, d: out };
}

/** Gaussian blur (sigma in pixels): a direct kernel for small sigmas, three box passes for large ones. */
export function gaussBlur(r: Raster, sigma: number): Raster {
  if (sigma < 0.2) return copyRaster(r);
  if (sigma > 3) {
    // Box radii whose three passes match the Gaussian's variance.
    const rr = Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5;
    return boxBlur(boxBlur(boxBlur(r, rr), rr), rr);
  }
  const R = Math.ceil(sigma * 3);
  const kernel = new Float32Array(2 * R + 1);
  let total = 0;
  for (let i = -R; i <= R; i++) total += kernel[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= total;
  const { w, h } = r;
  const tmp = new Float32Array(r.d.length);
  const out = new Float32Array(r.d.length);
  const pass = (src: Float32Array, dst: Float32Array, start: number, stride: number, n: number) => {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -R; k <= R; k++) s += src[start + clamp(i + k, 0, n - 1) * stride]! * kernel[k + R]!;
      dst[start + i * stride] = s;
    }
  };
  for (let c = 0; c < 4; c++) {
    for (let y = 0; y < h; y++) pass(r.d, tmp, y * w * 4 + c, 4, w);
    for (let x = 0; x < w; x++) pass(tmp, out, x * 4 + c, w * 4, h);
  }
  return { w, h, d: out };
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
  const tmp = new Float32Array(p.length);
  const out = new Float32Array(p.length);
  const line = (src: Float32Array, dst: Float32Array, start: number, stride: number, n: number) => {
    let sum = 0;
    for (let i = -r; i <= 0; i++) sum += src[start + clamp(i, 0, n - 1) * stride]!;
    for (let i = 0; i < n; i++) {
      dst[start + i * stride] = sum / (r + 1);
      sum += src[start + clamp(i + 1, 0, n - 1) * stride]! - src[start + clamp(i - r, 0, n - 1) * stride]!;
    }
  };
  for (let y = 0; y < h; y++) line(p, tmp, y * w, 1, w);
  for (let x = 0; x < w; x++) line(tmp, out, x, w, h);
  return out;
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
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      const hist = new Uint32Array(256);
      let count = 0;
      const add = (xx: number, dd: number) => {
        const x = clamp(xx, 0, w - 1);
        for (let yy = y - r; yy <= y + r; yy++) {
          hist[px[(clamp(yy, 0, h - 1) * w + x) * 4 + c]!]! += dd;
          count += dd;
        }
      };
      for (let xx = -r; xx <= r; xx++) add(xx, 1);
      for (let x = 0; x < w; x++) {
        const target = Math.floor(count / 2);
        let acc = 0;
        let v = 0;
        while (v < 255 && acc + hist[v]! <= target) acc += hist[v++]!;
        out[(y * w + x) * 4 + c] = v;
        add(x - r, -1);
        add(x + r + 1, 1);
      }
    }
  }
  return out;
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
