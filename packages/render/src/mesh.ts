import type { Paint } from "@gesso/core";

// Mesh gradients: the control grid is interpolated with a Catmull-Rom surface (it passes
// through every point, with smooth curves between them, like Illustrator's smooth mesh
// points), sampled densely and drawn as Gouraud-shaded triangles.

export type MeshGradient = Extract<Paint, { kind: "mesh-gradient" }>;
export type MeshVertices = { positions: Float32Array; colors: Float32Array; indices: number[] };

/** Most vertices CanvasKit can index with 16 bits. */
const MAX_VERTICES = 65_000;

const catmull = (p0: number, p1: number, p2: number, p3: number, t: number) =>
  0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);

/** Triangles covering a w×h box, with positions in pixels and RGBA colours as 0..1 floats. */
export function meshVertices(mesh: MeshGradient, w: number, h: number): MeshVertices {
  const rows = mesh.colors.length;
  const cols = mesh.colors[0]!.length;
  // Each control point: x, y in pixels and r, g, b, a as 0..1.
  const control = mesh.colors.map((row, i) =>
    row.map((color, j) => {
      const [fx, fy] = mesh.points?.[i]?.[j] ?? [j / (cols - 1), i / (rows - 1)];
      return [fx * w, fy * h, ...rgba(color)];
    }),
  );
  // Subdivide each cell into s×s quads, about 6 px each, within the vertex budget.
  const cell = Math.max(w / (cols - 1), h / (rows - 1));
  let s = Math.max(2, Math.min(48, Math.ceil(cell / 6)));
  while (((rows - 1) * s + 1) * ((cols - 1) * s + 1) > MAX_VERTICES && s > 2) s--;
  const vr = (rows - 1) * s + 1;
  const vc = (cols - 1) * s + 1;

  const at = (i: number, j: number) => control[Math.max(0, Math.min(rows - 1, i))]![Math.max(0, Math.min(cols - 1, j))]!;
  const positions = new Float32Array(vr * vc * 2);
  const colors = new Float32Array(vr * vc * 4);
  const value = new Array<number>(6);
  for (let a = 0; a < vr; a++) {
    const i = Math.min(rows - 2, Math.floor(a / s));
    const v = a / s - i;
    for (let b = 0; b < vc; b++) {
      const j = Math.min(cols - 2, Math.floor(b / s));
      const u = b / s - j;
      for (let k = 0; k < 6; k++) {
        // Along each of the four neighbouring rows, then across them.
        const across = [-1, 0, 1, 2].map((di) => catmull(at(i + di, j - 1)[k]!, at(i + di, j)[k]!, at(i + di, j + 1)[k]!, at(i + di, j + 2)[k]!, u));
        value[k] = catmull(across[0]!, across[1]!, across[2]!, across[3]!, v);
      }
      const n = a * vc + b;
      positions[n * 2] = value[0]!;
      positions[n * 2 + 1] = value[1]!;
      for (let c = 0; c < 4; c++) colors[n * 4 + c] = Math.min(1, Math.max(0, value[2 + c]!));
    }
  }
  const indices: number[] = [];
  for (let a = 0; a < vr - 1; a++) {
    for (let b = 0; b < vc - 1; b++) {
      const n = a * vc + b;
      indices.push(n, n + 1, n + vc, n + 1, n + vc + 1, n + vc);
    }
  }
  return { positions, colors, indices };
}

function rgba(color: string): [number, number, number, number] {
  const n = color.slice(1);
  const c = (k: number) => parseInt(n.slice(k, k + 2), 16) / 255;
  return [c(0), c(2), c(4), n.length === 8 ? c(6) : 1];
}
