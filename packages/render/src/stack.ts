// Auto-Align and Auto-Blend Layers: phase correlation to line exposures up, and per-pixel weights to merge
// a focus stack (the sharpest frame wins) or an exposure bracket (Mertens exposure fusion). Images are
// straight RGBA at the same size.

export type Rgba = { width: number; height: number; pixels: Uint8Array };

/** Luminance 0..1, transparent pixels as 0. */
function gray(img: Rgba): Float64Array {
  const out = new Float64Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    const p = img.pixels;
    out[i] = ((0.299 * p[i * 4]! + 0.587 * p[i * 4 + 1]! + 0.114 * p[i * 4 + 2]!) / 255) * (p[i * 4 + 3]! / 255);
  }
  return out;
}

/** Resamples a plane (bilinear) to w×h, optionally rotated by `angle` degrees and scaled by `scale` about its centre. */
function resample(src: Float64Array, sw: number, sh: number, w: number, h: number, scale = 1, angle = 0): Float64Array {
  const out = new Float64Array(w * h);
  const [cos, sin] = [Math.cos((angle * Math.PI) / 180), Math.sin((angle * Math.PI) / 180)];
  const [kx, ky] = [sw / w, sh / h];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Inverse map: output pixel → source, undoing the rotation and scale about the centre.
      const [dx, dy] = [(x - w / 2) / scale, (y - h / 2) / scale];
      const [ux, uy] = [(cos * dx + sin * dy + w / 2) * kx, (-sin * dx + cos * dy + h / 2) * ky];
      const [x0, y0] = [Math.floor(ux), Math.floor(uy)];
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) continue;
      const [fx, fy] = [ux - x0, uy - y0];
      const i = y0 * sw + x0;
      out[y * w + x] = (src[i]! * (1 - fx) + src[i + 1]! * fx) * (1 - fy) + (src[i + sw]! * (1 - fx) + src[i + sw + 1]! * fx) * fy;
    }
  return out;
}

/** In-place radix-2 FFT (inverse when `inverse`), on real and imaginary arrays of a power-of-two length. */
function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const [wr, wi] = [Math.cos(angle), Math.sin(angle)];
    for (let i = 0; i < n; i += len) {
      let [cr, ci] = [1, 0];
      for (let j = 0; j < len / 2; j++) {
        const [a, b] = [i + j, i + j + len / 2];
        const [tr, ti] = [re[b]! * cr - im[b]! * ci, re[b]! * ci + im[b]! * cr];
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
}

function fft2(re: Float64Array, im: Float64Array, n: number, inverse = false): void {
  const [r, c] = [new Float64Array(n), new Float64Array(n)];
  for (let y = 0; y < n; y++) {
    r.set(re.subarray(y * n, y * n + n));
    c.set(im.subarray(y * n, y * n + n));
    fft(r, c, inverse);
    re.set(r, y * n);
    im.set(c, y * n);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) [r[y], c[y]] = [re[y * n + x]!, im[y * n + x]!];
    fft(r, c, inverse);
    for (let y = 0; y < n; y++) [re[y * n + x], im[y * n + x]] = [r[y]!, c[y]!];
  }
}

/**
 * Phase correlation: the shift [dx, dy] that moves `b` onto `a` (both n×n), with sub-pixel peak refinement,
 * and the peak's strength (higher is a more certain match).
 */
function correlate(a: Float64Array, b: Float64Array, n: number): { dx: number; dy: number; peak: number } {
  // A Hann window keeps the image edges from dominating.
  const hann = (i: number) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  const [ar, ai, br, bi] = [new Float64Array(n * n), new Float64Array(n * n), new Float64Array(n * n), new Float64Array(n * n)];
  let [ma, mb] = [0, 0];
  for (let i = 0; i < n * n; i++) {
    ma += a[i]!;
    mb += b[i]!;
  }
  [ma, mb] = [ma / (n * n), mb / (n * n)];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const k = hann(x) * hann(y);
      ar[y * n + x] = (a[y * n + x]! - ma) * k;
      br[y * n + x] = (b[y * n + x]! - mb) * k;
    }
  fft2(ar, ai, n);
  fft2(br, bi, n);
  // Cross-power spectrum, normalised to unit magnitude.
  for (let i = 0; i < n * n; i++) {
    const [re, im] = [ar[i]! * br[i]! + ai[i]! * bi[i]!, ai[i]! * br[i]! - ar[i]! * bi[i]!];
    const mag = Math.hypot(re, im) + 1e-12;
    [ar[i], ai[i]] = [re / mag, im / mag];
  }
  fft2(ar, ai, n, true);
  let [best, at] = [-Infinity, 0];
  for (let i = 0; i < n * n; i++) if (ar[i]! > best) [best, at] = [ar[i]!, i];
  const [px, py] = [at % n, Math.floor(at / n)];
  const v = (x: number, y: number) => ar[((y + n) % n) * n + ((x + n) % n)]!;
  const sub = (l: number, c: number, r: number) => (l - r) / (2 * (l - 2 * c + r) || 1);
  const sx = px + sub(v(px - 1, py), best, v(px + 1, py));
  const sy = py + sub(v(px, py - 1), best, v(px, py + 1));
  return { dx: sx > n / 2 ? sx - n : sx, dy: sy > n / 2 ? sy - n : sy, peak: best };
}

export type Alignment = { dx: number; dy: number; scale: number; rotation: number; confidence: number };

/**
 * How to move `moving` to line it up with `reference` (Auto-Align Layers): a shift in pixels and,
 * when searched, a scale (focus breathing) and rotation (handheld) about the centre.
 */
export function alignTo(reference: Rgba, moving: Rgba, search: { scale?: boolean; rotation?: boolean } = {}): Alignment {
  const { width: w, height: h } = reference;
  const n = 256;
  const [a0, b0] = [gray(reference), gray(moving)];
  const a = resample(a0, w, h, n, n);
  let best = { scale: 1, rotation: 0, ...correlate(a, resample(b0, w, h, n, n), n) };
  const scales = search.scale ? [0.96, 0.97, 0.98, 0.99, 1.01, 1.02, 1.03, 1.04] : [];
  const angles = search.rotation ? [-2, -1.5, -1, -0.5, 0.5, 1, 1.5, 2] : [];
  for (const scale of [1, ...scales])
    for (const rotation of [0, ...angles]) {
      if (scale === 1 && rotation === 0) continue;
      const r = correlate(a, resample(b0, w, h, n, n, scale, rotation), n);
      if (r.peak > best.peak * 1.02) best = { scale, rotation, ...r };
    }
  // The shift was measured on a square n×n resample: back to the image's own pixels on each axis.
  return { dx: best.dx * (w / n), dy: best.dy * (h / n), scale: best.scale, rotation: best.rotation, confidence: Math.round(best.peak * 1000) / 1000 };
}

/** Box mean of a plane over a (2r+1)² window. */
function blurPlane(p: Float64Array, w: number, h: number, r: number): Float64Array {
  if (r < 1) return p;
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += p[y * w + Math.min(w - 1, Math.max(0, k))]!;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += p[y * w + Math.min(w - 1, x + r + 1)]! - p[y * w + Math.max(0, x - r)]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, k)) * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
    }
  }
  return out;
}

/** |Laplacian| of luminance: local detail. */
function detail(img: Rgba): Float64Array {
  const { width: w, height: h } = img;
  const g = gray(img);
  const out = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) out[y * w + x] = Math.abs(4 * g[y * w + x]! - g[y * w + x - 1]! - g[y * w + x + 1]! - g[(y - 1) * w + x]! - g[(y + 1) * w + x]!);
  return out;
}

/**
 * Auto-Blend weights for each layer (summing to 1 per pixel). Focus: the frame with the most local detail
 * wins, softly. Exposure: Mertens exposure fusion, favouring contrast, saturation and well-exposed tones.
 * `smoothness` (px) blurs the weights so seams don't show.
 */
export function blendWeights(images: Rgba[], mode: "focus" | "exposure", smoothness: number): Float64Array[] {
  const { width: w, height: h } = images[0]!;
  const n = w * h;
  const raw = images.map((img) => {
    if (mode === "focus") {
      const energy = blurPlane(detail(img), w, h, Math.max(2, Math.round(smoothness / 4)));
      return energy.map((e) => (e + 1e-6) ** 4);
    }
    const contrast = detail(img);
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const [r, g, b] = [img.pixels[i * 4]! / 255, img.pixels[i * 4 + 1]! / 255, img.pixels[i * 4 + 2]! / 255];
      const mean = (r + g + b) / 3;
      const saturation = Math.sqrt(((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3);
      const exposed = Math.exp(-((r - 0.5) ** 2 + (g - 0.5) ** 2 + (b - 0.5) ** 2) / (2 * 0.2 * 0.2));
      out[i] = (contrast[i]! + 0.02) * (saturation + 0.02) * exposed + 1e-9;
    }
    return out;
  });
  const smooth = raw.map((p) => blurPlane(blurPlane(p, w, h, Math.round(smoothness / 2)), w, h, Math.round(smoothness / 2)));
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const p of smooth) s += p[i]!;
    for (const p of smooth) p[i] = s > 0 ? p[i]! / s : 1 / smooth.length;
  }
  return smooth;
}

/**
 * Weights as layer masks for a normal stack, bottom layer first: the bottom shows everywhere, and each layer
 * above covers what's below by w_k / (w_1 + … + w_k), so the result is Σ w_k · layer_k.
 */
export function stackMasks(weights: Float64Array[]): Uint8Array[] {
  const n = weights[0]!.length;
  const below = new Float64Array(n);
  return weights.map((w, k) => {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      below[i] = below[i]! + w[i]!;
      mask[i] = k === 0 ? 255 : Math.round(Math.min(1, w[i]! / (below[i]! || 1)) * 255);
    }
    return mask;
  });
}
