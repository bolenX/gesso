import type { CanvasKit, RuntimeEffect } from "canvaskit-wasm";

// Distortion and directional blur filters as SkSL runtime shaders. Each samples the layer's
// pixels (the child shader `img`) at moved positions; CanvasKit runs them on the CPU raster
// pipeline, which is far faster than resampling in JavaScript.

const SOURCES = {
  // Ribs across `dir`: each shows the image shifted by up to ±amount/2, so every rib holds a
  // displaced, slightly squeezed slice, like Photoshop's Glass filter with a ramp texture.
  glass: `
    uniform shader img;
    uniform float2 dir;
    uniform float2 origin;
    uniform float size;
    uniform float amount;
    uniform float wave;
    half4 main(float2 p) {
      float t = fract(dot(p + origin, dir) / size);
      float d = mix(t - 0.5, 0.5 * sin(6.2831853 * t), wave);
      return img.eval(p + dir * d * amount);
    }`,
  // Averages samples along one direction, centred on the pixel. The blur runs at a scale where
  // the distance is about 24 pixels, so 24 samples cover it without gaps.
  motion: `
    uniform shader img;
    uniform float2 delta;
    half4 main(float2 p) {
      half4 sum = half4(0);
      for (int i = 0; i < 24; i++) {
        sum += img.eval(p + delta * (float(i) / 23.0 - 0.5));
      }
      return sum / 24.0;
    }`,
  // Like motion, but the direction at each pixel comes from a field image (red and green hold
  // the direction, 0.5 meaning zero), so the smear bends with the path.
  path: `
    uniform shader img;
    uniform shader field;
    uniform float dist;
    half4 main(float2 p) {
      float2 dir = field.eval(p).rg * 2.0 - 1.0;
      float l = length(dir);
      dir = l > 0.001 ? dir / l : float2(1, 0);
      half4 sum = half4(0);
      for (int i = 0; i < 24; i++) {
        sum += img.eval(p + dir * dist * (float(i) / 23.0 - 0.5));
      }
      return sum / 24.0;
    }`,
} as const;

export type ShaderName = keyof typeof SOURCES;

const compiled = new WeakMap<CanvasKit, Map<ShaderName, RuntimeEffect>>();

export function shaderEffect(ck: CanvasKit, name: ShaderName): RuntimeEffect {
  let cache = compiled.get(ck);
  if (!cache) compiled.set(ck, (cache = new Map()));
  let effect = cache.get(name);
  if (!effect) {
    const errors: string[] = [];
    effect = ck.RuntimeEffect.Make(SOURCES[name], (e) => errors.push(e)) ?? undefined;
    if (!effect) throw new Error(`Could not compile the ${name} shader: ${errors.join("; ")}`);
    cache.set(name, effect);
  }
  return effect;
}

/** A smooth curve through the points (Catmull-Rom), as a polyline of about 64 points. */
export function samplePath(points: Array<[number, number]>): Array<[number, number]> {
  if (points.length === 2) return points;
  const out: Array<[number, number]> = [];
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))]!;
  const n = 64;
  for (let k = 0; k <= n; k++) {
    const g = (k / n) * (points.length - 1);
    const i = Math.min(points.length - 2, Math.floor(g));
    const t = g - i;
    const v = [0, 1].map((c) => {
      const [p0, p1, p2, p3] = [at(i - 1)[c]!, at(i)[c]!, at(i + 1)[c]!, at(i + 2)[c]!];
      return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
    });
    out.push([v[0]!, v[1]!]);
  }
  return out;
}

/**
 * The blur direction at every pixel of a w×h image: the path's tangent, weighted towards the
 * nearest segments (inverse square distance), encoded as RGBA with 128 meaning zero.
 */
export function directionField(path: Array<[number, number]>, w: number, h: number): Uint8Array {
  const segs = path.slice(1).map((b, i) => {
    const a = path[i]!;
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const len = Math.hypot(dx, dy);
    return { a, dx, dy, len2: dx * dx + dy * dy, tx: len ? dx / len : 0, ty: len ? dy / len : 0 };
  }).filter((s) => s.len2 > 1e-6);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let [vx, vy] = [0, 0];
      for (const s of segs) {
        const t = Math.max(0, Math.min(1, ((x - s.a[0]) * s.dx + (y - s.a[1]) * s.dy) / s.len2));
        const [qx, qy] = [s.a[0] + s.dx * t - x, s.a[1] + s.dy * t - y];
        const wgt = 1 / (qx * qx + qy * qy + 1);
        vx += s.tx * wgt;
        vy += s.ty * wgt;
      }
      const l = Math.hypot(vx, vy) || 1;
      const n = (y * w + x) * 4;
      out[n] = Math.round((vx / l) * 127 + 128);
      out[n + 1] = Math.round((vy / l) * 127 + 128);
      out[n + 2] = 128;
      out[n + 3] = 255;
    }
  }
  return out;
}
