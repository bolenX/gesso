// Matting: the maths behind Select and Mask, studio-backdrop keys and clean-plate keys.
//
// A rough mask says roughly where the subject is. Matting works out how much of each edge pixel is subject:
//   1. The trimap: solid subject, clear background, and the uncertain band around the edge between them,
//      wider where the edge has fine detail like hair ("smart radius").
//   2. The opacity in that band, from the image itself: closed-form matting (Levin, Lischinski and Weiss, 2008),
//      which assumes the subject's and background's colours each change smoothly over small windows. It's solved
//      with preconditioned conjugate gradients over the unknown pixels only, and guided by a local colour
//      estimate where it's sure (robust matting's data term). Big bands are solved at a lower resolution and
//      brought back to full detail with a fast guided filter (He and Sun, 2015).
//   3. The subject's own colour in the soft edge, without the old background mixed in: multi-level foreground
//      estimation (Germer, Uelwer, Conrad and Harmeling, 2020). That's what Decontaminate Colors uses.
//
// Images here are planar float channels 0..1 (one array per channel), and masks are 0..1.

import { rgbToLab } from "./cpu.js";

type Planes = [Float64Array, Float64Array, Float64Array];

/** Sums over the (2r+1)² window around each pixel, cut off at the image's edges (no repeated edge pixels). */
function boxSum(src: Float64Array, out: Float64Array, tmp: Float64Array, w: number, h: number, r: number): Float64Array {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) s += src[row + x]!;
    for (let x = 0; x < w; x++) {
      tmp[row + x] = s;
      if (x + r + 1 < w) s += src[row + x + r + 1]!;
      if (x - r >= 0) s -= src[row + x - r]!;
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) s += tmp[y * w + x]!;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s;
      if (y + r + 1 < h) s += tmp[(y + r + 1) * w + x]!;
      if (y - r >= 0) s -= tmp[(y - r) * w + x]!;
    }
  }
  return out;
}

/** Mean over the (2r+1)² window around each pixel, cut off at the edges. */
export function boxMean(src: Float64Array, w: number, h: number, r: number): Float64Array {
  const n = w * h;
  const sum = boxSum(src, new Float64Array(n), new Float64Array(n), w, h, r);
  for (let y = 0; y < h; y++) {
    const rows = Math.min(h - 1, y + r) - Math.max(0, y - r) + 1;
    for (let x = 0; x < w; x++) sum[y * w + x]! /= rows * (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
  }
  return sum;
}

/** A box mean over a wide window, worked out at a smaller size when the window is wide enough not to notice. */
function wideMean(src: Float64Array, w: number, h: number, r: number): Float64Array {
  const q = Math.floor(r / 4);
  if (q < 2) return boxMean(src, w, h, r);
  const [sw, sh] = [Math.ceil(w / q), Math.ceil(h / q)];
  return enlarge(boxMean(shrink(src, w, h, q), sw, sh, Math.max(1, Math.round(r / q))), sw, sh, w, h, q);
}

/** Distance from each pixel to the nearest pixel that's set (Euclidean and exact: Felzenszwalb and Huttenlocher). */
export function distanceTransform(on: Uint8Array, w: number, h: number): Float64Array {
  const INF = 1e20;
  const size = Math.max(w, h);
  const f = new Float64Array(size);
  const d = new Float64Array(size);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = on[i] ? 0 : INF;
  const pass = (n: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k--;
        s = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++;
      d[q] = (q - v[k]!) ** 2 + f[v[k]!]!;
    }
  };
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!;
    pass(h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]!;
    pass(w);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]!);
  }
  return grid;
}

/** Straight 8-bit RGBA as planar 0..1 channels. */
export function planesOf(rgba: Uint8Array, n: number): Planes {
  const planes: Planes = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) planes[c]![i] = rgba[i * 4 + c]! / 255;
  return planes;
}

// ── Trimap ───────────────────────────────────────────────────────────────────────────────

/** Trimap values: clear background, solid subject, and the band to solve. */
export const BG = 0;
export const FG = 2;
export const UNKNOWN = 1;

/**
 * Colour-line estimate of the opacity in a band: where each pixel's colour falls between the subject's colour
 * nearby (averaged from the solid inside) and the background's (from the clear outside). Quick and local, so a
 * wrong band doesn't mislead it: it's the solver's starting point and its data term, and tells smart radius
 * where the edge has detail. `confidence` (0..1) is high where the two colours differ and the pixel sits on the
 * line between them.
 */
export function colourLine(I: Planes, m: Float64Array, w: number, h: number, reach: number): Float64Array & { confidence?: Float64Array } {
  const n = w * h;
  const fg = new Float64Array(n);
  const bg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    fg[i] = m[i]! >= 0.98 ? 1 : 0;
    bg[i] = m[i]! <= 0.02 ? 1 : 0;
  }
  const fgWeight = wideMean(fg, w, h, reach);
  const bgWeight = wideMean(bg, w, h, reach);
  const fgColour = I.map((ch) => wideMean(ch.map((v, i) => v * fg[i]!), w, h, reach));
  const bgColour = I.map((ch) => wideMean(ch.map((v, i) => v * bg[i]!), w, h, reach));
  const alpha: Float64Array & { confidence?: Float64Array } = Float64Array.from(m);
  const confidence = new Float64Array(n);
  const f = new Float64Array(3);
  const b = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    if (fgWeight[i]! < 1e-3 || bgWeight[i]! < 1e-3) continue;
    let [dot, len] = [0, 0];
    for (let c = 0; c < 3; c++) {
      f[c] = fgColour[c]![i]! / fgWeight[i]!;
      b[c] = bgColour[c]![i]! / bgWeight[i]!;
      dot += (I[c]![i]! - b[c]!) * (f[c]! - b[c]!);
      len += (f[c]! - b[c]!) ** 2;
    }
    // Subject and background look alike here: colour can't tell them apart, so the rough mask stands.
    if (len < 0.006) continue;
    const t = Math.min(1, Math.max(0, dot / len));
    alpha[i] = t;
    // How far the colour is from the line between them: far off, the estimate means little.
    let off = 0;
    for (let c = 0; c < 3; c++) off += (I[c]![i]! - (b[c]! + t * (f[c]! - b[c]!))) ** 2;
    confidence[i] = (len / (len + 0.02)) * Math.exp(-off / (0.1 * len + 1e-4));
  }
  alpha.confidence = confidence;
  return alpha;
}

/**
 * The trimap of a rough mask: pixels within `radius` of its edge (or already soft) are unknown, and so are
 * pixels up to twice as far whose colour clearly says otherwise than the mask. With smart radius the band stays
 * narrow (a quarter of the radius) along clean edges and keeps its full width only where the image shows fine
 * detail crossing the edge, judged from the colour-line estimate.
 */
export function makeTrimap(I: Planes, m: Float64Array, w: number, h: number, radius: number, smart: boolean, estimate?: Float64Array & { confidence?: Float64Array }): Uint8Array {
  const n = w * h;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (m[i]! >= 0.5) inside[i] = 1;
    else outside[i] = 1;
  }
  const toOutside = distanceTransform(outside, w, h);
  const toInside = distanceTransform(inside, w, h);
  let detail: Float64Array | undefined;
  if (smart) {
    // Detail: the rough estimate is neither clearly in nor clearly out, a little way from the edge.
    const line = estimate ?? colourLine(I, m, w, h, Math.max(2, Math.round(radius)));
    const mixed = new Float64Array(n);
    for (let i = 0; i < n; i++) mixed[i] = line[i]! > 0.08 && line[i]! < 0.92 ? 1 : 0;
    detail = boxMean(mixed, w, h, Math.max(2, Math.round(radius / 4)));
  }
  const narrow = Math.max(1.5, radius / 4);
  const tri = new Uint8Array(n);
  const sure = estimate?.confidence;
  for (let i = 0; i < n; i++) {
    const d = inside[i] ? toOutside[i]! : toInside[i]!;
    const soft = m[i]! > 0.02 && m[i]! < 0.98;
    const reach = detail ? (d <= narrow || detail[i]! > 0.04 ? radius : 0) : radius;
    // Just past the band, colour can still overrule the rough mask: a strand that runs on beyond it, or a gap
    // inside it, is solved rather than taken as background or subject.
    const disputed = !!sure && d <= radius * 2 && sure[i]! > 0.3 && (inside[i] ? estimate![i]! < 0.7 : estimate![i]! > 0.3);
    tri[i] = soft || d <= reach || disputed ? UNKNOWN : inside[i] ? FG : BG;
  }
  return tri;
}

// ── Closed-form matting ──────────────────────────────────────────────────────────────────

/** Inverse of a symmetric 3×3 matrix [a b c; b d e; c e f], as its six entries. */
function invertSym(a: number, b: number, c: number, d: number, e: number, f: number, out: Float64Array, o: number): void {
  const A = d * f - e * e;
  const B = c * e - b * f;
  const C = b * e - c * d;
  const det = a * A + b * B + c * C;
  const k = Math.abs(det) > 1e-30 ? 1 / det : 0;
  out[o] = A * k;
  out[o + 1] = B * k;
  out[o + 2] = C * k;
  out[o + 3] = (a * f - c * c) * k;
  out[o + 4] = (b * c - a * e) * k;
  out[o + 5] = (a * d - b * b) * k;
}

export type SolveOptions = {
  /** Window radius: 1 (3×3 windows) keeps the finest detail. */
  r?: number;
  /** Regularisation: larger is smoother. */
  eps?: number;
  /** Most conjugate-gradient steps. */
  iterations?: number;
  /** Stop once the residual has fallen by this factor. */
  tolerance?: number;
  /**
   * A local estimate the solve should also respect, with a weight per pixel (robust matting's data term): it
   * keeps detail the band's edges would otherwise pull away, such as strands that run past it.
   */
  prior?: { value: Float64Array; weight: Float64Array };
  /** How strongly the prior counts against the Laplacian's smoothness. */
  priorStrength?: number;
  /** For matte: the most unknown pixels to solve at full size (SOLVE_UNKNOWN). */
  maxUnknown?: number;
};

/**
 * Solves opacity in the trimap's unknown band by closed-form matting. Only the unknown pixels are variables:
 * the matting Laplacian's rows for them are built explicitly (a (4r+1)² stencil each), the known pixels move
 * to the right-hand side, and preconditioned conjugate gradients solve it, with an incomplete Cholesky
 * factorisation as the preconditioner. `start` is the first guess for the unknown pixels.
 */
export function solveMatte(I: Planes, tri: Uint8Array, start: Float64Array, w: number, h: number, options: SolveOptions = {}): Float64Array {
  const n = w * h;
  const r = options.r ?? 1;
  const eps = options.eps ?? 1e-5;
  const maxIter = options.iterations ?? 400;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = tri[i] === UNKNOWN ? Math.min(1, Math.max(0, start[i]!)) : tri[i] === FG ? 1 : 0;
  const index = new Int32Array(n).fill(-1);
  const pixels: number[] = [];
  let known = false;
  for (let i = 0; i < n; i++) {
    if (tri[i] === UNKNOWN) index[i] = pixels.push(i) - 1;
    else known = true;
  }
  const nu = pixels.length;
  if (!nu || !known) return x;

  // The stencil: neighbours within 2r, as slots in each row.
  const R = 2 * r;
  const side = 2 * R + 1;
  const S = side * side;
  const centre = R * side + R;
  const slot = (dx: number, dy: number) => (dy + R) * side + dx + R;
  const col = new Int32Array(nu * S).fill(-1);
  for (let k = 0; k < nu; k++) {
    const p = pixels[k]!;
    const [px, py] = [p % w, Math.floor(p / w)];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const [qx, qy] = [px + dx, py + dy];
        if (qx >= 0 && qx < w && qy >= 0 && qy < h) col[k * S + slot(dx, dy)] = index[qy * w + qx]!;
      }
    }
  }

  // The Laplacian, window by window: every full window that holds an unknown pixel adds
  // δ_pq − (1 + (I_p − μ)ᵀ Δ⁻¹ (I_q − μ)) / |w| between its pixels p and q.
  const A = new Float64Array(nu * S);
  const b = new Float64Array(nu);
  const size = (2 * r + 1) ** 2;
  const inv = new Float64Array(6);
  const win = new Int32Array(size);
  const centred = new Float64Array(size * 3);
  const visited = new Uint8Array(n);
  for (const p of pixels) {
    const [px, py] = [p % w, Math.floor(p / w)];
    for (let cy = Math.max(r, py - r); cy <= Math.min(h - 1 - r, py + r); cy++) {
      for (let cx = Math.max(r, px - r); cx <= Math.min(w - 1 - r, px + r); cx++) {
        const c = cy * w + cx;
        if (visited[c]) continue;
        visited[c] = 1;
        let k = 0;
        let [m0, m1, m2] = [0, 0, 0];
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const q = (cy + dy) * w + cx + dx;
            win[k++] = q;
            m0 += I[0][q]!;
            m1 += I[1][q]!;
            m2 += I[2][q]!;
          }
        }
        [m0, m1, m2] = [m0 / size, m1 / size, m2 / size];
        let [s00, s01, s02, s11, s12, s22] = [0, 0, 0, 0, 0, 0];
        for (let j = 0; j < size; j++) {
          const q = win[j]!;
          const [d0, d1, d2] = [I[0][q]! - m0, I[1][q]! - m1, I[2][q]! - m2];
          centred[j * 3] = d0;
          centred[j * 3 + 1] = d1;
          centred[j * 3 + 2] = d2;
          s00 += d0 * d0;
          s01 += d0 * d1;
          s02 += d0 * d2;
          s11 += d1 * d1;
          s12 += d1 * d2;
          s22 += d2 * d2;
        }
        const reg = eps / size;
        invertSym(s00 / size + reg, s01 / size, s02 / size, s11 / size + reg, s12 / size, s22 / size + reg, inv, 0);
        for (let a = 0; a < size; a++) {
          const ka = index[win[a]!]!;
          if (ka < 0) continue;
          const [a0, a1, a2] = [centred[a * 3]!, centred[a * 3 + 1]!, centred[a * 3 + 2]!];
          const t0 = inv[0]! * a0 + inv[1]! * a1 + inv[2]! * a2;
          const t1 = inv[1]! * a0 + inv[3]! * a1 + inv[4]! * a2;
          const t2 = inv[2]! * a0 + inv[4]! * a1 + inv[5]! * a2;
          const pa = win[a]!;
          for (let q = 0; q < size; q++) {
            const g = (a === q ? 1 : 0) - (1 + t0 * centred[q * 3]! + t1 * centred[q * 3 + 1]! + t2 * centred[q * 3 + 2]!) / size;
            const kq = index[win[q]!]!;
            if (kq >= 0) {
              const pq = win[q]!;
              A[ka * S + slot((pq % w) - (pa % w), Math.floor(pq / w) - Math.floor(pa / w))]! += g;
            } else b[ka]! -= g * x[win[q]!]!;
          }
        }
      }
    }
  }
  // A weak pull towards the first guess keeps pixels that no full window reaches (at the image's edge) defined;
  // the prior, where there is one, pulls harder where it's sure.
  const pull = 1e-5;
  const strength = options.priorStrength ?? 0.5;
  for (let k = 0; k < nu; k++) {
    const p = pixels[k]!;
    const weight = options.prior ? strength * options.prior.weight[p]! : 0;
    A[k * S + centre]! += pull + weight;
    b[k]! += pull * x[p]! + (weight ? weight * options.prior!.value[p]! : 0);
  }

  // Incomplete Cholesky, IC(0): L with the stencil's lower half, A ≈ L·Lᵀ. Rows come in pixel order, so a
  // lower slot's neighbour always comes first.
  const lower: number[] = [];
  for (let dy = -R; dy <= 0; dy++) for (let dx = -R; dx <= R; dx++) if (dy < 0 || dx < 0) lower.push(slot(dx, dy));
  const offset = (s: number) => [(s % side) - R, Math.floor(s / side) - R] as const;
  // For row i, lower slots s1 (neighbour j) and s2 (neighbour m, before j): where m sits in row j, if it does.
  const shared = lower.map((s1) =>
    lower.map((s2) => {
      const [ax, ay] = offset(s1);
      const [bx, by] = offset(s2);
      const [dx, dy] = [bx - ax, by - ay];
      if (Math.abs(dx) > R || Math.abs(dy) > R || !(dy < 0 || (dy === 0 && dx < 0))) return -1;
      return slot(dx, dy);
    }),
  );
  const L = new Float64Array(nu * S);
  const factor = (shift: number) => {
    L.fill(0);
    for (let i = 0; i < nu; i++) {
      const row = i * S;
      for (let li = 0; li < lower.length; li++) {
        const s1 = lower[li]!;
        const j = col[row + s1]!;
        if (j < 0) continue;
        let v = A[row + s1]!;
        const rowJ = j * S;
        for (let lk = 0; lk < lower.length; lk++) {
          const inJ = shared[li]![lk]!;
          if (inJ < 0) continue;
          const s2 = lower[lk]!;
          if (col[row + s2]! < 0) continue;
          v -= L[row + s2]! * L[rowJ + inJ]!;
        }
        L[row + s1] = v / L[rowJ + centre]!;
      }
      let d = A[row + centre]! * (1 + shift);
      for (const s of lower) if (col[row + s]! >= 0) d -= L[row + s]! ** 2;
      if (!(d > 0)) return false;
      L[row + centre] = Math.sqrt(d);
    }
    return true;
  };
  let shift = 0;
  while (!factor(shift)) shift = shift ? shift * 10 : 1e-3;
  // Packed rows for the solve: A's entries, L's lower entries and Lᵀ's (L's, read the other way).
  const pack = (keep: (slotIndex: number) => boolean, value: (row: number, slotIndex: number) => number) => {
    const ptr = new Int32Array(nu + 1);
    for (let i = 0; i < nu; i++) {
      let count = 0;
      for (let t = 0; t < S; t++) if (col[i * S + t]! >= 0 && keep(t)) count++;
      ptr[i + 1] = ptr[i]! + count;
    }
    const cols = new Int32Array(ptr[nu]!);
    const vals = new Float64Array(ptr[nu]!);
    for (let i = 0; i < nu; i++) {
      let at = ptr[i]!;
      for (let t = 0; t < S; t++) {
        const j = col[i * S + t]!;
        if (j < 0 || !keep(t)) continue;
        cols[at] = j;
        vals[at++] = value(i, t);
      }
    }
    return { ptr, cols, vals };
  };
  const isLower = new Uint8Array(S);
  for (const t of lower) isLower[t] = 1;
  const Ap = pack(() => true, (i, t) => A[i * S + t]!);
  const Lp = pack((t) => isLower[t] === 1, (i, t) => L[i * S + t]!);
  // Lᵀ's row i holds L[j][i] for the rows j after i that list i: the mirror of i's upper slots.
  const Up = pack((t) => isLower[S - 1 - t] === 1, (i, t) => L[col[i * S + t]! * S + (S - 1 - t)]!);
  const diag = new Float64Array(nu);
  for (let i = 0; i < nu; i++) diag[i] = L[i * S + centre]!;
  const precondition = (res: Float64Array, z: Float64Array) => {
    for (let i = 0; i < nu; i++) {
      let v = res[i]!;
      for (let e = Lp.ptr[i]!; e < Lp.ptr[i + 1]!; e++) v -= Lp.vals[e]! * z[Lp.cols[e]!]!;
      z[i] = v / diag[i]!;
    }
    for (let i = nu - 1; i >= 0; i--) {
      let v = z[i]!;
      for (let e = Up.ptr[i]!; e < Up.ptr[i + 1]!; e++) v -= Up.vals[e]! * z[Up.cols[e]!]!;
      z[i] = v / diag[i]!;
    }
  };
  const multiply = (v: Float64Array, out: Float64Array) => {
    for (let i = 0; i < nu; i++) {
      let s = 0;
      for (let e = Ap.ptr[i]!; e < Ap.ptr[i + 1]!; e++) s += Ap.vals[e]! * v[Ap.cols[e]!]!;
      out[i] = s;
    }
  };

  // Preconditioned conjugate gradients from the first guess.
  const u = new Float64Array(nu);
  for (let k = 0; k < nu; k++) u[k] = x[pixels[k]!]!;
  const Au = new Float64Array(nu);
  multiply(u, Au);
  const res = b.map((v, k) => v - Au[k]!);
  const z = new Float64Array(nu);
  precondition(res, z);
  const dir = Float64Array.from(z);
  let rz = 0;
  let r0 = 0;
  for (let k = 0; k < nu; k++) {
    rz += res[k]! * z[k]!;
    r0 += res[k]! * res[k]!;
  }
  const tol = (options.tolerance ?? 1e-5) * Math.sqrt(r0);
  const Ad = new Float64Array(nu);
  for (let it = 0; it < maxIter && r0 > 0; it++) {
    multiply(dir, Ad);
    let dAd = 0;
    for (let k = 0; k < nu; k++) dAd += dir[k]! * Ad[k]!;
    if (!(dAd > 0)) break;
    const step = rz / dAd;
    let norm = 0;
    for (let k = 0; k < nu; k++) {
      u[k]! += step * dir[k]!;
      res[k]! -= step * Ad[k]!;
      norm += res[k]! * res[k]!;
    }
    if (Math.sqrt(norm) <= tol) break;
    precondition(res, z);
    let rzNext = 0;
    for (let k = 0; k < nu; k++) rzNext += res[k]! * z[k]!;
    const beta = rzNext / rz;
    rz = rzNext;
    for (let k = 0; k < nu; k++) dir[k] = z[k]! + beta * dir[k]!;
  }
  for (let k = 0; k < nu; k++) x[pixels[k]!] = Math.min(1, Math.max(0, u[k]!));
  return x;
}

/** A guided filter's per-pixel linear coefficients (q = a·I + b), already averaged over each window. */
function guidedCoefficients(I: Planes, p: Float64Array, w: number, h: number, r: number, eps: number): { a: Planes; b: Float64Array } {
  const n = w * h;
  const mean = (src: Float64Array) => boxMean(src, w, h, r);
  const mI = I.map(mean) as Planes;
  const mp = mean(p);
  const pairs: Array<[number, number]> = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
  const cov = pairs.map(([a, b]) => {
    const prod = new Float64Array(n);
    for (let i = 0; i < n; i++) prod[i] = I[a]![i]! * I[b]![i]!;
    const s = mean(prod);
    for (let i = 0; i < n; i++) s[i] = s[i]! - mI[a]![i]! * mI[b]![i]!;
    return s;
  });
  const covIp = I.map((ch, c) => {
    const prod = new Float64Array(n);
    for (let i = 0; i < n; i++) prod[i] = ch[i]! * p[i]!;
    const s = mean(prod);
    for (let i = 0; i < n; i++) s[i] = s[i]! - mI[c]![i]! * mp[i]!;
    return s;
  });
  const a: Planes = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const b = new Float64Array(n);
  const inv = new Float64Array(6);
  for (let i = 0; i < n; i++) {
    invertSym(cov[0]![i]! + eps, cov[1]![i]!, cov[2]![i]!, cov[3]![i]! + eps, cov[4]![i]!, cov[5]![i]! + eps, inv, 0);
    const [v0, v1, v2] = [covIp[0]![i]!, covIp[1]![i]!, covIp[2]![i]!];
    a[0][i] = inv[0]! * v0 + inv[1]! * v1 + inv[2]! * v2;
    a[1][i] = inv[1]! * v0 + inv[3]! * v1 + inv[4]! * v2;
    a[2][i] = inv[2]! * v0 + inv[4]! * v1 + inv[5]! * v2;
    b[i] = mp[i]! - (a[0][i]! * mI[0][i]! + a[1][i]! * mI[1][i]! + a[2][i]! * mI[2][i]!);
  }
  return { a: a.map(mean) as Planes, b: mean(b) };
}

/** Guided filter: p smoothed so its edges follow the guide image's (He, Sun and Tang). */
export function guidedFilter(I: Planes, p: Float64Array, w: number, h: number, r: number, eps: number): Float64Array {
  const { a, b } = guidedCoefficients(I, p, w, h, r, eps);
  const q = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) q[i] = a[0][i]! * I[0][i]! + a[1][i]! * I[1][i]! + a[2][i]! * I[2][i]! + b[i]!;
  return q;
}

/**
 * Fast guided filter (He and Sun, 2015): the coefficients worked out on the small image and its small result,
 * enlarged, then applied with the full-size guide, so the result's edges come back at full detail.
 */
export function guidedUpsample(small: Planes, p: Float64Array, sw: number, sh: number, I: Planes, w: number, h: number, f: number, r: number, eps: number): Float64Array {
  const { a, b } = guidedCoefficients(small, p, sw, sh, r, eps);
  const [a0, a1, a2] = a.map((plane) => enlarge(plane, sw, sh, w, h, f));
  const B = enlarge(b, sw, sh, w, h, f);
  const q = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) q[i] = a0![i]! * I[0][i]! + a1![i]! * I[1][i]! + a2![i]! * I[2][i]! + B[i]!;
  return q;
}

// ── Foreground colour ────────────────────────────────────────────────────────────────────

/**
 * The subject's own colour under each pixel (and the background's), from the image and its opacity:
 * multi-level foreground estimation. Coarse levels settle the colours, fine ones add detail, so strands keep
 * their own colour instead of an average.
 */
export function estimateForeground(I: Planes, alpha: Float64Array, w: number, h: number): Planes {
  const levels = Math.ceil(Math.log2(Math.max(w, h, 2)));
  let F: Planes | undefined;
  let B: Planes | undefined;
  let [pw, ph] = [1, 1];
  const resize = (src: Float64Array, sw: number, sh: number, dw: number, dh: number) => {
    const out = new Float64Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
      for (let x = 0; x < dw; x++) out[y * dw + x] = src[sy * sw + Math.min(sw - 1, Math.floor((x * sw) / dw))]!;
    }
    return out;
  };
  for (let level = 0; level <= levels; level++) {
    const lw = Math.max(1, Math.round(w ** (level / levels)));
    const lh = Math.max(1, Math.round(h ** (level / levels)));
    const img = I.map((ch) => resize(ch, w, h, lw, lh)) as Planes;
    const a = resize(alpha, w, h, lw, lh);
    F = F ? (F.map((ch) => resize(ch, pw, ph, lw, lh)) as Planes) : (img.map((ch) => Float64Array.from(ch)) as Planes);
    B = B ? (B.map((ch) => resize(ch, pw, ph, lw, lh)) as Planes) : (img.map((ch) => Float64Array.from(ch)) as Planes);
    const iterations = lw <= 32 && lh <= 32 ? 10 : 2;
    const [I0, I1, I2] = img;
    const [F0, F1, F2] = F;
    const [B0, B1, B2] = B;
    const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    for (let it = 0; it < iterations; it++) {
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          const i = y * lw + x;
          const a0 = a[i]!;
          const a1 = 1 - a0;
          let a00 = a0 * a0;
          const a01 = a0 * a1;
          let a11 = a1 * a1;
          let [f0, f1, f2] = [I0![i]! * a0, I1![i]! * a0, I2![i]! * a0];
          let [b0, b1, b2] = [I0![i]! * a1, I1![i]! * a1, I2![i]! * a1];
          // The four neighbours, edges repeating.
          for (let k = 0; k < 4; k++) {
            const j = k === 0 ? (x > 0 ? i - 1 : i) : k === 1 ? (x < lw - 1 ? i + 1 : i) : k === 2 ? (y > 0 ? i - lw : i) : y < lh - 1 ? i + lw : i;
            const da = 1e-5 + Math.abs(a0 - a[j]!);
            a00 += da;
            a11 += da;
            f0 += da * F0![j]!;
            f1 += da * F1![j]!;
            f2 += da * F2![j]!;
            b0 += da * B0![j]!;
            b1 += da * B1![j]!;
            b2 += da * B2![j]!;
          }
          const inv = 1 / (a00 * a11 - a01 * a01);
          F0![i] = clamp(inv * (a11 * f0 - a01 * b0));
          F1![i] = clamp(inv * (a11 * f1 - a01 * b1));
          F2![i] = clamp(inv * (a11 * f2 - a01 * b2));
          B0![i] = clamp(inv * (a00 * b0 - a01 * f0));
          B1![i] = clamp(inv * (a00 * b1 - a01 * f1));
          B2![i] = clamp(inv * (a00 * b2 - a01 * f2));
        }
      }
    }
    [pw, ph] = [lw, lh];
  }
  return F!;
}

// ── Keys ─────────────────────────────────────────────────────────────────────────────────

/**
 * Fills a smooth colour field over the whole image from the pixels with weight (push-pull over a pyramid):
 * the backdrop as it would look behind the subject, falloff and vignette included.
 */
export function pushPull(values: Planes, weight: Float64Array, w: number, h: number): Planes {
  // Each level holds a colour and how sure it is of it (0..1).
  type Level = { w: number; h: number; v: Planes; wt: Float64Array };
  const levels: Level[] = [{ w, h, v: values.map((ch) => Float64Array.from(ch)) as Planes, wt: weight.map((x) => Math.min(1, Math.max(0, x))) }];
  while (levels.at(-1)!.w > 1 || levels.at(-1)!.h > 1) {
    const fine = levels.at(-1)!;
    const lw = Math.ceil(fine.w / 2);
    const lh = Math.ceil(fine.h / 2);
    const v: Planes = [new Float64Array(lw * lh), new Float64Array(lw * lh), new Float64Array(lw * lh)];
    const total = new Float64Array(lw * lh);
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        const j = (y >> 1) * lw + (x >> 1);
        total[j]! += fine.wt[i]!;
        for (let c = 0; c < 3; c++) v[c]![j]! += fine.v[c]![i]! * fine.wt[i]!;
      }
    }
    for (let j = 0; j < lw * lh; j++) if (total[j]! > 0) for (let c = 0; c < 3; c++) v[c]![j]! /= total[j]!;
    levels.push({ w: lw, h: lh, v, wt: total.map((t) => Math.min(1, t)) });
  }
  // Pull: each level, now whole, fills in where the one above it is unsure.
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l]!;
    const coarse = levels[l + 1]!;
    for (let y = 0; y < fine.h; y++) {
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        const j = (y >> 1) * coarse.w + (x >> 1);
        const t = fine.wt[i]!;
        for (let c = 0; c < 3; c++) fine.v[c]![i] = t * fine.v[c]![i]! + (1 - t) * coarse.v[c]![j]!;
        fine.wt[i] = 1;
      }
    }
  }
  return levels[0]!.v;
}

/** Colour difference (CIE76 ΔE) between two planar images, per pixel. */
export function deltaE(a: Planes, b: Planes, n: number): Float64Array {
  const la = new Float64Array(3);
  const lb = new Float64Array(3);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    rgbToLab(a[0][i]!, a[1][i]!, a[2][i]!, la);
    rgbToLab(b[0][i]!, b[1][i]!, b[2][i]!, lb);
    out[i] = Math.hypot(la[0]! - lb[0]!, la[1]! - lb[1]!, la[2]! - lb[2]!);
  }
  return out;
}

const ramp = (lo: number, hi: number, v: number) => {
  const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

/**
 * Studio backdrop key: the backdrop's colour is read from the image's border (or given), then filled in behind
 * the subject as a smooth field so lighting falloff doesn't count as subject. Opacity rises with the colour
 * difference from that field: below `tolerance` (ΔE) it's backdrop, above three times it, subject.
 * `opaque` marks the pixels that belong to the source at all.
 */
export function backdropKey(I: Planes, opaque: Uint8Array, w: number, h: number, options: { color?: [number, number, number]; tolerance?: number } = {}): Float64Array {
  const n = w * h;
  const tolerance = options.tolerance ?? 10;
  let field: Planes;
  if (options.color) {
    field = options.color.map((v) => new Float64Array(n).fill(v)) as Planes;
  } else {
    // The border of the source's own area: its outermost 2% on every side.
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!opaque[y * w + x]) continue;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    }
    if (x1 < 0) return new Float64Array(n);
    const band = Math.max(2, Math.round(Math.min(x1 - x0, y1 - y0) * 0.02));
    const weight = new Float64Array(n);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        if (opaque[i] && (x - x0 < band || x1 - x < band || y - y0 < band || y1 - y < band)) weight[i] = 1;
      }
    }
    // Twice over: the border's median colour picks out the backdrop pixels, then those (and, the second time,
    // every pixel close to the first field) shape the field.
    const median = [0, 1, 2].map((c) => {
      const vals: number[] = [];
      for (let i = 0; i < n; i++) if (weight[i]) vals.push(I[c]![i]!);
      vals.sort((a, b) => a - b);
      return vals[Math.floor(vals.length / 2)] ?? 1;
    });
    field = median.map((v) => new Float64Array(n).fill(v)) as Planes;
    for (let pass = 0; pass < 2; pass++) {
      const d = deltaE(I, field, n);
      const seeds = new Float64Array(n);
      for (let i = 0; i < n; i++) if (opaque[i] && (weight[i] || pass > 0) && d[i]! < tolerance * 2.5) seeds[i] = 1;
      field = pushPull(I, seeds, w, h);
    }
  }
  const d = deltaE(I, field, n);
  const alpha = new Float64Array(n);
  for (let i = 0; i < n; i++) alpha[i] = opaque[i] ? ramp(tolerance, tolerance * 3, d[i]!) : 0;
  return alpha;
}

/** Clean-plate key: opacity rises with the colour difference from the same scene shot without the subject. */
export function differenceKey(I: Planes, plate: Planes, opaque: Uint8Array, n: number, tolerance = 8): Float64Array {
  const d = deltaE(I, plate, n);
  const alpha = new Float64Array(n);
  for (let i = 0; i < n; i++) alpha[i] = opaque[i] ? ramp(tolerance, tolerance * 3, d[i]!) : 0;
  return alpha;
}

// ── Putting it together ──────────────────────────────────────────────────────────────────

/** Most unknown pixels a solve takes on at once; bigger bands are solved smaller and brought back with a fast guided filter. */
export const SOLVE_UNKNOWN = 60_000;

/** Average of each f×f block. */
function shrink(src: Float64Array, w: number, h: number, f: number): Float64Array {
  const [sw, sh] = [Math.ceil(w / f), Math.ceil(h / f)];
  const out = new Float64Array(sw * sh);
  const count = new Float64Array(sw * sh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = Math.floor(y / f) * sw + Math.floor(x / f);
      out[j]! += src[y * w + x]!;
      count[j]!++;
    }
  }
  for (let j = 0; j < out.length; j++) out[j]! /= count[j]!;
  return out;
}

/** Bilinear enlargement of a shrunk image back to w×h. */
function enlarge(src: Float64Array, sw: number, sh: number, w: number, h: number, f: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) / f - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) / f - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = sx - x0;
      const top = src[y0 * sw + x0]! * (1 - tx) + src[y0 * sw + x1]! * tx;
      const bottom = src[y1 * sw + x0]! * (1 - tx) + src[y1 * sw + x1]! * tx;
      out[y * w + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

/** Opacity for a trimap: solved directly, or for a big band at a smaller size and then guided back to full detail. */
export function matte(I: Planes, tri: Uint8Array, start: Float64Array, w: number, h: number, options: SolveOptions = {}): Float64Array {
  const n = w * h;
  let unknown = 0;
  for (let i = 0; i < n; i++) if (tri[i] === UNKNOWN) unknown++;
  const cap = options.maxUnknown ?? SOLVE_UNKNOWN;
  const f = unknown > cap ? Math.ceil(Math.sqrt(unknown / cap)) : 1;
  if (f === 1) return solveMatte(I, tri, start, w, h, options);
  const [sw, sh] = [Math.ceil(w / f), Math.ceil(h / f)];
  const small = I.map((ch) => shrink(ch, w, h, f)) as Planes;
  // A block is known only if all of it is.
  const fg = shrink(Float64Array.from(tri, (t) => (t === FG ? 1 : 0)), w, h, f);
  const bg = shrink(Float64Array.from(tri, (t) => (t === BG ? 1 : 0)), w, h, f);
  const smallTri = Uint8Array.from(fg, (v, j) => (v >= 1 ? FG : bg[j]! >= 1 ? BG : UNKNOWN));
  const prior = options.prior ? { value: shrink(options.prior.value, w, h, f), weight: shrink(options.prior.weight, w, h, f) } : undefined;
  const solved = solveMatte(small, smallTri, shrink(start, w, h, f), sw, sh, { ...options, ...(prior ? { prior } : {}) });
  const guided = guidedUpsample(small, solved, sw, sh, I, w, h, f, 1, 1e-4);
  for (let i = 0; i < n; i++) guided[i] = tri[i] === UNKNOWN ? Math.min(1, Math.max(0, guided[i]!)) : tri[i] === FG ? 1 : 0;
  return guided;
}
