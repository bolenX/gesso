import { warpSurface } from "@gesso/render";

// Gesso warps and Photoshop's custom warp. Gesso's warp is a grid the surface passes through
// smoothly; Photoshop's is a bicubic Bézier patch whose 4×4 control points mostly lie off the
// surface. Converting samples the surface at a 4×4 grid of parameters and solves for the control
// points that pass through those samples, so the two agree exactly there and closely between.

type Point = [number, number];

/** Bernstein weights at t = 0, 1/3, 2/3, 1 (rows), for control points 0..3 (columns). */
const M = [0, 1 / 3, 2 / 3, 1].map((t) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3]);

/** The inverse of a 4×4 matrix, by Gauss–Jordan elimination. */
function invert(m: number[][]): number[][] {
  const a = m.map((row, i) => [...row, ...[0, 1, 2, 3].map((j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < 4; c++) {
    let pivot = c;
    for (let r = c + 1; r < 4; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[pivot]![c]!)) pivot = r;
    [a[c], a[pivot]] = [a[pivot]!, a[c]!];
    const p = a[c]![c]!;
    for (let j = 0; j < 8; j++) a[c]![j]! /= p;
    for (let r = 0; r < 4; r++) {
      if (r === c) continue;
      const f = a[r]![c]!;
      for (let j = 0; j < 8; j++) a[r]![j]! -= f * a[c]![j]!;
    }
  }
  return a.map((row) => row.slice(4));
}

const Minv = invert(M);

/** Photoshop's 16 control points (row by row, in the content's pixels) for a Gesso warp grid over a w×h box. */
export function toBezierMesh(grid: Point[][], w: number, h: number): Array<{ x: number; y: number }> {
  const surface = warpSurface(grid);
  const samples = [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i) => surface(i / 3, j / 3)));
  // Control points C = Minv · S · Minvᵀ, per axis: rows of S run down (v), columns across (u).
  const out: Array<{ x: number; y: number }> = [];
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let [x, y] = [0, 0];
      for (let k = 0; k < 4; k++)
        for (let l = 0; l < 4; l++) {
          const weight = Minv[r]![k]! * Minv[c]![l]!;
          x += weight * samples[k]![l]![0];
          y += weight * samples[k]![l]![1];
        }
      out.push({ x: Math.round(x * w * 1000) / 1000, y: Math.round(y * h * 1000) / 1000 });
    }
  return out;
}

/** A Gesso warp grid (4×4, fractions of the box) from Photoshop's control points over a box of the given bounds. */
export function fromBezierMesh(mesh: Array<{ x: number; y: number }>, bounds: { left: number; top: number; right: number; bottom: number }): Point[][] {
  const [w, h] = [bounds.right - bounds.left || 1, bounds.bottom - bounds.top || 1];
  const at = (u: number, v: number): Point => {
    let [x, y] = [0, 0];
    const bu = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
    const bv = [(1 - v) ** 3, 3 * v * (1 - v) ** 2, 3 * v * v * (1 - v), v ** 3];
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 4; c++) {
        const p = mesh[r * 4 + c]!;
        x += bv[r]! * bu[c]! * p.x;
        y += bv[r]! * bu[c]! * p.y;
      }
    return [Math.round(((x - bounds.left) / w) * 10000) / 10000, Math.round(((y - bounds.top) / h) * 10000) / 10000];
  };
  return [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i) => at(i / 3, j / 3)));
}
