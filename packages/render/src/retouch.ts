import { boxPlane, clamp, hash, samplePlane } from "./cpu.js";

// Retouching on straight colour planes (0..1): Clone Stamp, Content-Aware Fill (PatchMatch),
// healing (seamless blending of the fill into its surroundings) and Content-Aware Scale (seams).

export type Planes = Float32Array[];

/** A region as fractions of the layer's box: centre, size, ellipse or rectangle, soft edge in pixels. */
export type Spot = { at: [number, number]; size: [number, number]; shape?: "ellipse" | "rect"; feather?: number };

/** Coverage (0..1) of spots in an image whose pixel (0, 0) sits at the box's (bx, by), box size bw×bh. */
export function spotMask(spots: Spot[], w: number, h: number, bx: number, by: number, bw: number, bh: number, k: number): Float32Array {
  const m = new Float32Array(w * h);
  for (const s of spots) {
    const [cx, cy] = [bx + s.at[0] * bw, by + s.at[1] * bh];
    const [rx, ry] = [(s.size[0] * bw) / 2, (s.size[1] * bh) / 2];
    const f = Math.max(0.5, (s.feather ?? 2) * k);
    const [x0, x1] = [Math.max(0, Math.floor(cx - rx - f)), Math.min(w - 1, Math.ceil(cx + rx + f))];
    const [y0, y1] = [Math.max(0, Math.floor(cy - ry - f)), Math.min(h - 1, Math.ceil(cy + ry + f))];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const [dx, dy] = [x + 0.5 - cx, y + 0.5 - cy];
        // Distance outside the shape's edge, in pixels (negative inside).
        const d =
          s.shape === "rect"
            ? Math.max(Math.abs(dx) - rx, Math.abs(dy) - ry)
            : (Math.sqrt((dx / Math.max(rx, 0.5)) ** 2 + (dy / Math.max(ry, 0.5)) ** 2) - 1) * Math.min(rx, ry);
        const v = clamp(0.5 - d / f, 0, 1);
        if (v > m[y * w + x]!) m[y * w + x] = v;
      }
  }
  return m;
}

/** The planes shifted so each pixel shows the one `offset` pixels away (Clone Stamp's source). */
export function shifted(planes: Planes, w: number, h: number, dx: number, dy: number): Planes {
  return planes.map((p) => {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = samplePlane(p, w, h, x + 0.5 + dx, y + 0.5 + dy);
    return out;
  });
}

/** Blends b over a by the mask (0..1). */
export function blendPlanes(a: Planes, b: Planes, mask: Float32Array): Planes {
  return a.map((p, c) => p.map((v, i) => v + (b[c]![i]! - v) * mask[i]!));
}

// ── Membrane (Laplace) fill ───────────────────────────────────────────────────────────────

/**
 * Fills the unknown pixels (known[i] = 0) smoothly from the known ones around them: the
 * harmonic membrane, solved coarse to fine. Known pixels keep their values.
 */
export function membrane(values: Planes, known: Uint8Array, w: number, h: number): Planes {
  if (w * h <= 64 || (w < 4 && h < 4)) return relax(values, known, w, h, values.map((p) => p.slice()), 200);
  // Solve at half size first, for a good start.
  const [hw, hh] = [Math.ceil(w / 2), Math.ceil(h / 2)];
  const small = values.map(() => new Float32Array(hw * hh));
  const smallKnown = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      let n = 0;
      const sums = values.map(() => 0);
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const [xx, yy] = [2 * x + i, 2 * y + j];
          if (xx >= w || yy >= h || !known[yy * w + xx]) continue;
          n++;
          values.forEach((p, c) => (sums[c]! += p[yy * w + xx]!));
        }
      if (n) {
        smallKnown[y * hw + x] = 1;
        values.forEach((_, c) => (small[c]![y * hw + x] = sums[c]! / n));
      }
    }
  const coarse = membrane(small, smallKnown, hw, hh);
  const start = values.map((p, c) => p.map((v, i) => (known[i] ? v : coarse[c]![Math.min(hh - 1, Math.floor(Math.floor(i / w) / 2)) * hw + Math.min(hw - 1, Math.floor((i % w) / 2))]!)));
  return relax(values, known, w, h, start, 30);
}

/** Jacobi iterations of the Laplace equation over the unknown pixels. */
function relax(values: Planes, known: Uint8Array, w: number, h: number, start: Planes, iterations: number): Planes {
  const holes: number[] = [];
  for (let i = 0; i < w * h; i++) if (!known[i]) holes.push(i);
  let cur = start;
  for (let it = 0; it < iterations; it++) {
    const next = cur.map((p) => p.slice());
    for (const i of holes) {
      const [x, y] = [i % w, Math.floor(i / w)];
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1].filter((n) => n >= 0);
      for (let c = 0; c < cur.length; c++) {
        let s = 0;
        for (const n of nb) s += cur[c]![n]!;
        next[c]![i] = s / nb.length;
      }
    }
    cur = next;
  }
  values.forEach((p, c) => {
    for (let i = 0; i < w * h; i++) if (known[i]) cur[c]![i] = p[i]!;
  });
  return cur;
}

/**
 * Healing: the fill keeps its texture but takes on the light and colour around the region, by
 * adding the smooth membrane that matches the fill to the original at the region's edge
 * (Poisson blending, like the Healing Brush).
 */
export function heal(original: Planes, fill: Planes, region: Float32Array, w: number, h: number): Planes {
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = region[i]! < 0.01 ? 1 : 0;
  const difference = original.map((p, c) => p.map((v, i) => v - fill[c]![i]!));
  const correction = membrane(difference, known, w, h);
  return blendPlanes(original, fill.map((p, c) => p.map((v, i) => v + correction[c]![i]!)), region);
}

// ── Content-Aware Fill (PatchMatch) ───────────────────────────────────────────────────────

/**
 * Fills the hole (hole[i] = 1) with patches from elsewhere in the image, coarse to fine: at each
 * scale, PatchMatch finds for every patch over the hole the most similar patch outside it, and
 * each hole pixel becomes the average of what those patches put there (Wexler et al.). The last
 * pass at full size takes each pixel from its single best patch instead, so grain and pores carry
 * over rather than averaging into a smooth blur.
 */
export function contentAwareFill(planes: Planes, hole: Uint8Array, w: number, h: number, seed = 1): Planes {
  const levels: Array<{ planes: Planes; hole: Uint8Array; w: number; h: number }> = [{ planes, hole, w, h }];
  // Halve until the hole is small enough to start from a smooth guess.
  while (true) {
    const top = levels[levels.length - 1]!;
    let size = 0;
    for (let i = 0; i < top.hole.length; i++) size += top.hole[i]!;
    if (size < 64 || top.w < 32 || top.h < 32 || levels.length > 8) break;
    levels.push(halve(top.planes, top.hole, top.w, top.h));
  }
  const coarsest = levels[levels.length - 1]!;
  const known = coarsest.hole.map((v) => 1 - v);
  let estimate = membrane(coarsest.planes, known, coarsest.w, coarsest.h);
  for (let l = levels.length - 1; l >= 0; l--) {
    const level = levels[l]!;
    if (l < levels.length - 1) {
      const prev = levels[l + 1]!;
      estimate = level.planes.map((p, c) => p.map((v, i) => (level.hole[i] ? samplePlane(estimate[c]!, prev.w, prev.h, ((i % level.w) + 0.5) / 2, (Math.floor(i / level.w) + 0.5) / 2) : v)));
    }
    const iterations = l === 0 ? 2 : 4;
    for (let it = 0; it < iterations; it++) estimate = patchMatchPass(level.planes, estimate, level.hole, level.w, level.h, seed + l * 31 + it, l === 0 && it === iterations - 1);
  }
  return restoreTexture(planes, estimate, hole, w, h);
}

/** Fine detail: each plane minus a small blur of itself. */
const detail = (p: Float32Array, w: number, h: number) => {
  const soft = boxPlane(boxPlane(p, w, h, 1), w, h, 1);
  return p.map((v, i) => v - soft[i]!);
};

/**
 * PatchMatch over a smooth first guess favours the flattest patches, so fills come out smoother than
 * their surroundings: grain, pores and noise thin out. This measures the fine detail in a ring around
 * the hole, and when the fill has less, adds the missing part from the detail of a nearby area of
 * similar tone (Spot Healing's proximity match). The fill's own structure, an edge through the hole,
 * stays; only the variance it lacks is added.
 */
function restoreTexture(original: Planes, fill: Planes, hole: Uint8Array, w: number, h: number): Planes {
  const near = dilate(hole, w, h, 2);
  const origDetail = original.map((p) => detail(p, w, h));
  const fillDetail = fill.map((p) => detail(p, w, h));
  const soft = fill.map((p) => boxPlane(p, w, h, 2));
  const softOrig = original.map((p) => boxPlane(p, w, h, 2));
  const lum = (p: Planes, i: number) => (p[0]![i]! + p[1]![i]! + p[2]![i]!) / 3;
  const out = fill.map((p) => p.slice());
  // Each separate spot is matched on its own: one borrowed area per spot, measured against its own surroundings.
  const label = new Int32Array(w * h).fill(-1);
  let count = 0;
  for (let seed = 0; seed < w * h; seed++) {
    if (!hole[seed] || label[seed]! >= 0) continue;
    const pixels: number[] = [];
    const stack = [seed];
    label[seed] = count;
    while (stack.length) {
      const i = stack.pop()!;
      pixels.push(i);
      const [x, y] = [i % w, Math.floor(i / w)];
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]] as const) {
        const j = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && hole[j] && label[j]! < 0) {
          label[j] = count;
          stack.push(j);
        }
      }
    }
    restoreSpot(pixels);
    count++;
  }
  return out;

  function restoreSpot(pixels: number[]) {
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    for (const i of pixels) {
      const [x, y] = [i % w, Math.floor(i / w)];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
    // The spot's surroundings: a ring 3–8 px out, away from every hole.
    let [want, wn] = [0, 0];
    for (let y = Math.max(0, y0 - 8); y <= Math.min(h - 1, y1 + 8); y++)
      for (let x = Math.max(0, x0 - 8); x <= Math.min(w - 1, x1 + 8); x++) {
        const i = y * w + x;
        if (near[i]) continue;
        for (const p of origDetail) {
          want += p[i]! ** 2;
          wn++;
        }
      }
    let [have, hn] = [0, 0];
    for (const i of pixels)
      for (const p of fillDetail) {
        have += p[i]! ** 2;
        hn++;
      }
    [want, have] = [Math.sqrt(want / Math.max(1, wn)), Math.sqrt(have / Math.max(1, hn))];
    if (!want || have >= want * 0.9) return;
    const [bw, bh] = [x1 - x0 + 1, y1 - y0 + 1];
    let best: [number, number] | undefined;
    let bestScore = Infinity;
    for (const m of [1.2, 1.8, 2.6, 3.5]) {
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        const [dx, dy] = [Math.round(Math.cos(a) * (bw * m + 2)), Math.round(Math.sin(a) * (bh * m + 2))];
        if (x0 + dx < 0 || y0 + dy < 0 || x1 + dx >= w || y1 + dy >= h) continue;
        let [score, n, clash] = [0, 0, false];
        for (const i of pixels) {
          const j = i + dy * w + dx;
          if (near[j]) {
            clash = true;
            break;
          }
          score += Math.abs(lum(soft, i) - lum(softOrig, j));
          n++;
        }
        if (clash || !n) continue;
        if (score / n < bestScore) [bestScore, best] = [score / n, [dx, dy]];
      }
    }
    if (!best) return;
    const shift = best[1] * w + best[0];
    let [borrowed, bn] = [0, 0];
    for (const i of pixels)
      for (const p of origDetail) {
        borrowed += p[i + shift]! ** 2;
        bn++;
      }
    borrowed = Math.sqrt(borrowed / Math.max(1, bn));
    if (!borrowed) return;
    const gain = Math.sqrt(Math.max(0, want * want - have * have)) / borrowed;
    for (const i of pixels) for (let c = 0; c < out.length; c++) out[c]![i] = out[c]![i]! + origDetail[c]![i + shift]! * gain;
  }
}

function halve(planes: Planes, hole: Uint8Array, w: number, h: number) {
  const [hw, hh] = [Math.ceil(w / 2), Math.ceil(h / 2)];
  const out = planes.map(() => new Float32Array(hw * hh));
  const outHole = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++)
    for (let x = 0; x < hw; x++) {
      let n = 0;
      for (let j = 0; j < 2; j++)
        for (let i = 0; i < 2; i++) {
          const [xx, yy] = [Math.min(w - 1, 2 * x + i), Math.min(h - 1, 2 * y + j)];
          if (hole[yy * w + xx]) outHole[y * hw + x] = 1;
          planes.forEach((p, c) => (out[c]![y * hw + x]! += p[yy * w + xx]!));
          n++;
        }
      out.forEach((p) => (p[y * hw + x]! /= n));
    }
  return { planes: out, hole: outHole, w: hw, h: hh };
}

const P = 3; // patch radius: 7×7 patches

/** One PatchMatch search and vote over the hole. `target` is the current estimate; `best` takes each pixel from its best patch. */
function patchMatchPass(source: Planes, target: Planes, hole: Uint8Array, w: number, h: number, seed: number, best = false): Planes {
  // Valid source centres: patches entirely outside the hole and inside the image.
  const holeNear = dilate(hole, w, h, P);
  const valid: number[] = [];
  for (let y = P; y < h - P; y++) for (let x = P; x < w - P; x++) if (!holeNear[y * w + x]) valid.push(y * w + x);
  if (!valid.length) return target;
  // Patches to fill: every centre whose patch touches the hole.
  const todo: number[] = [];
  for (let i = 0; i < w * h; i++) if (holeNear[i]) todo.push(i);
  const nnf = new Int32Array(w * h).fill(-1);
  const cost = new Float32Array(w * h).fill(Infinity);
  const distance = (t: number, s: number, limit: number) => {
    const [tx, ty, sx, sy] = [t % w, Math.floor(t / w), s % w, Math.floor(s / w)];
    let d = 0;
    for (let j = -P; j <= P; j++) {
      const [yt, ys] = [ty + j, sy + j];
      if (yt < 0 || yt >= h) continue;
      for (let i = -P; i <= P; i++) {
        const xt = tx + i;
        if (xt < 0 || xt >= w) continue;
        const [a, b] = [yt * w + xt, ys * w + sx + i];
        for (let c = 0; c < target.length; c++) {
          const e = target[c]![a]! - source[c]![b]!;
          d += e * e;
        }
      }
      if (d > limit) return d;
    }
    return d;
  };
  const tryMatch = (t: number, s: number) => {
    if (s < 0 || holeNear[s]) return;
    const [sx, sy] = [s % w, Math.floor(s / w)];
    if (sx < P || sy < P || sx >= w - P || sy >= h - P) return;
    const d = distance(t, s, cost[t]!);
    if (d < cost[t]!) {
      cost[t] = d;
      nnf[t] = s;
    }
  };
  let rnd = seed;
  const random = () => (rnd = (Math.imul(rnd, 1103515245) + 12345) | 0, ((rnd >>> 8) & 0xffff) / 0x10000);
  for (const t of todo) tryMatch(t, valid[Math.floor(hash(t, seed, 7) * valid.length)]!);
  for (let round = 0; round < 4; round++) {
    const order = round % 2 ? [...todo].reverse() : todo;
    const step = round % 2 ? -1 : 1;
    for (const t of order) {
      // Propagation: a neighbour's match, shifted by one, is often a good match here too.
      const [x, y] = [t % w, Math.floor(t / w)];
      if (x - step >= 0 && x - step < w && nnf[t - step]! >= 0) tryMatch(t, nnf[t - step]! + step);
      if (y - step >= 0 && y - step < h && nnf[t - step * w]! >= 0) tryMatch(t, nnf[t - step * w]! + step * w);
      // Random search around the current best, in shrinking circles.
      const best = nnf[t]!;
      if (best < 0) continue;
      for (let r = Math.max(w, h); r >= 1; r = Math.floor(r / 2)) {
        const [bx, by] = [best % w, Math.floor(best / w)];
        const [cx, cy] = [Math.round(bx + (random() * 2 - 1) * r), Math.round(by + (random() * 2 - 1) * r)];
        if (cx >= 0 && cx < w && cy >= 0 && cy < h) tryMatch(t, cy * w + cx);
      }
    }
  }
  if (best) {
    // Each hole pixel comes from the lowest-cost patch that covers it: texture is copied, not averaged.
    const out = target.map((p) => p.slice());
    const bestCost = new Float32Array(w * h).fill(Infinity);
    for (const t of todo) {
      const s = nnf[t]!;
      if (s < 0) continue;
      const [tx, ty, sx, sy] = [t % w, Math.floor(t / w), s % w, Math.floor(s / w)];
      for (let j = -P; j <= P; j++)
        for (let i = -P; i <= P; i++) {
          const [xt, yt] = [tx + i, ty + j];
          if (xt < 0 || yt < 0 || xt >= w || yt >= h) continue;
          const a = yt * w + xt;
          if (!hole[a] || cost[t]! >= bestCost[a]!) continue;
          bestCost[a] = cost[t]!;
          const b = (sy + j) * w + sx + i;
          for (let c = 0; c < target.length; c++) out[c]![a] = source[c]![b]!;
        }
    }
    return out;
  }
  // Vote: each hole pixel averages what the overlapping patches' matches put there.
  const sums = target.map(() => new Float64Array(w * h));
  const weights = new Float64Array(w * h);
  for (const t of todo) {
    const s = nnf[t]!;
    if (s < 0) continue;
    const wt = Math.exp(-cost[t]! / (2 * 49 * 0.01));
    const [tx, ty, sx, sy] = [t % w, Math.floor(t / w), s % w, Math.floor(s / w)];
    for (let j = -P; j <= P; j++)
      for (let i = -P; i <= P; i++) {
        const [xt, yt] = [tx + i, ty + j];
        if (xt < 0 || yt < 0 || xt >= w || yt >= h) continue;
        const a = yt * w + xt;
        if (!hole[a]) continue;
        const b = (sy + j) * w + sx + i;
        for (let c = 0; c < target.length; c++) sums[c]![a]! += source[c]![b]! * (wt + 1e-6);
        weights[a]! += wt + 1e-6;
      }
  }
  return target.map((p, c) => p.map((v, i) => (hole[i] && weights[i]! > 0 ? sums[c]![i]! / weights[i]! : v)));
}

function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) out[j * w + i] = 1;
    }
  return out;
}

// ── Content-Aware Scale (seam carving) ────────────────────────────────────────────────────

/**
 * Resizes by removing the least noticeable seams (Content-Aware Scale): for a narrower result,
 * vertical seams; for a shorter one, horizontal. Seams are found at reduced size (≤ 360 px across
 * the seams), then the full image is resampled along them. Returns, per output pixel, where it
 * comes from in the source.
 */
export function seamMap(luma: Float32Array, w: number, h: number, outW: number, outH: number): { x: Float32Array; y: Float32Array } {
  const vertical = outW < w;
  // Work transposed for horizontal seams so the same code finds both.
  const [W, H, target] = vertical ? [w, h, outW] : [h, w, outH];
  const at = (x: number, y: number) => (vertical ? luma[y * w + x]! : luma[x * w + y]!);
  const f = Math.max(1, W / 360);
  const [sw, sh] = [Math.max(2, Math.round(W / f)), Math.max(2, Math.round(H / f))];
  const small = new Float32Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) small[y * sw + x] = at(Math.min(W - 1, Math.floor((x + 0.5) * (W / sw))), Math.min(H - 1, Math.floor((y + 0.5) * (H / sh))));
  const remove = Math.max(0, Math.round(sw - (target / W) * sw));
  // cols[y] lists, for each row, the source columns still kept (in small units).
  const cols: number[][] = Array.from({ length: sh }, () => Array.from({ length: sw }, (_, x) => x));
  for (let s = 0; s < remove; s++) {
    const cw = sw - s;
    const energy = new Float32Array(cw * sh);
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < cw; x++) {
        const v = (xx: number, yy: number) => small[yy * sw + cols[yy]![Math.max(0, Math.min(cw - 1, xx))]!]!;
        energy[y * cw + x] = Math.abs(v(x + 1, y) - v(x - 1, y)) + Math.abs(v(x, Math.min(sh - 1, y + 1)) - v(x, Math.max(0, y - 1)));
      }
    // Cumulative minimum energy, top to bottom, then trace the cheapest seam back up.
    for (let y = 1; y < sh; y++)
      for (let x = 0; x < cw; x++) {
        const up = energy[(y - 1) * cw + x]!;
        const left = x > 0 ? energy[(y - 1) * cw + x - 1]! : Infinity;
        const right = x < cw - 1 ? energy[(y - 1) * cw + x + 1]! : Infinity;
        energy[y * cw + x]! += Math.min(up, left, right);
      }
    let x = 0;
    for (let i = 1; i < cw; i++) if (energy[(sh - 1) * cw + i]! < energy[(sh - 1) * cw + x]!) x = i;
    for (let y = sh - 1; y >= 0; y--) {
      cols[y]!.splice(x, 1);
      if (y > 0) {
        let best = x;
        for (const dx of [-1, 1]) {
          const nx = x + dx;
          if (nx >= 0 && nx < cw && energy[(y - 1) * cw + nx]! < energy[(y - 1) * cw + best]!) best = nx;
        }
        x = best;
      }
    }
  }
  // Each output pixel's source, back at full size.
  const [OW, OH] = vertical ? [outW, h] : [w, outH];
  const mx = new Float32Array(OW * OH);
  const my = new Float32Array(OW * OH);
  const kept = sw - remove;
  for (let oy = 0; oy < OH; oy++)
    for (let ox = 0; ox < OW; ox++) {
      const [u, v] = vertical ? [ox, oy] : [oy, ox];
      const across = vertical ? OW : OH;
      const row = cols[Math.min(sh - 1, Math.floor(((v + 0.5) / H) * sh))]!;
      const pos = ((u + 0.5) / across) * kept - 0.5;
      const i0 = Math.max(0, Math.min(kept - 1, Math.floor(pos)));
      const i1 = Math.min(kept - 1, i0 + 1);
      const t = clamp(pos - i0, 0, 1);
      const src = ((row[i0]! + (row[i1]! - row[i0]!) * t + 0.5) / sw) * W;
      if (vertical) [mx[oy * OW + ox], my[oy * OW + ox]] = [src, v + 0.5];
      else [mx[oy * OW + ox], my[oy * OW + ox]] = [v + 0.5, src];
    }
  return { x: mx, y: my };
}
