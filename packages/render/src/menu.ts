import type { Filter } from "@gesso/core";
import type { Image } from "canvaskit-wasm";
import { blank, boxPlane, clamp, fbm, fromPlanes, hash, len, luma, planes, readRaster, sample, samplePlane, smoothstep, type Raster } from "./cpu.js";
import type { FilterCtx } from "./filters.js";
import { project, rectToQuad, type Point } from "./perspective.js";
import { heal } from "./retouch.js";

// The rest of Photoshop's Filter menu: Adaptive Wide Angle and Vanishing Point from the top of the
// menu, Render's Flame, Picture Frame, Tree and Relight, and Other › Color to Alpha.

type Of<K extends Filter["kind"]> = Extract<Filter, { kind: K }>;
type Rgb = [number, number, number];
const hex = (c: string): Rgb => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as Rgb;

/** The layer's box in the image's pixels: left, top, width, height. */
const boxPx = (ctx: FilterCtx) => [ctx.box.x * ctx.k - ctx.ox, ctx.box.y * ctx.k - ctx.oy, ctx.box.w * ctx.k, ctx.box.h * ctx.k] as const;

/** Resamples by a map from output pixel centres to source points; points that fall off the image come out clear. */
function remapClear(src: Raster, map: (x: number, y: number, to: Float64Array) => boolean): Raster {
  const out = blank(src);
  const to = new Float64Array(2);
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      if (!map(x + 0.5, y + 0.5, to)) continue;
      if (to[0]! < 0 || to[1]! < 0 || to[0]! > src.w || to[1]! > src.h) continue;
      sample(src, to[0]!, to[1]!, out.d, (y * src.w + x) * 4);
    }
  return out;
}

// ── Other › Color to Alpha ───────────────────────────────────────────────────────────────

export function colorToAlpha(r: Raster, filter: Of<"color-to-alpha">): Raster {
  const key = hex(filter.color ?? "#FFFFFF");
  const [t0, t1] = [filter.transparency ?? 0, Math.max((filter.transparency ?? 0) + 1e-3, filter.opacity ?? 1)];
  const out = blank(r);
  // As in GIMP: each pixel becomes the least-opaque colour that, laid over the key colour, gives
  // back what was there. White paper drops out, and ink keeps its own colour.
  for (let i = 0; i < r.d.length; i += 4) {
    const a = r.d[i + 3]!;
    if (a <= 0) continue;
    const c = [r.d[i]! / a, r.d[i + 1]! / a, r.d[i + 2]! / a];
    let alpha = 0;
    for (let j = 0; j < 3; j++) {
      const [v, kk] = [c[j]!, key[j]!];
      const d = v > kk ? (v - kk) / (1 - kk || 1) : v < kk ? (kk - v) / (kk || 1) : 0;
      alpha = Math.max(alpha, d);
    }
    alpha = clamp((alpha - t0) / (t1 - t0), 0, 1);
    const na = a * alpha;
    out.d[i + 3] = na;
    if (alpha <= 0) continue;
    for (let j = 0; j < 3; j++) out.d[i + j] = clamp(key[j]! + (c[j]! - key[j]!) / alpha, 0, 1) * na;
  }
  return out;
}

// ── Adaptive Wide Angle ──────────────────────────────────────────────────────────────────

export function adaptiveWideAngle(ctx: FilterCtx, r: Raster, filter: Of<"adaptive-wide-angle">): Raster {
  const [bx, by, bw, bh] = boxPx(ctx);
  const [cx, cy] = [bx + bw / 2, by + bh / 2];
  const fisheye = filter.correction === "fisheye";
  // Focal length in pixels: the 36 mm full-frame width (divided by the crop factor) spans the photo.
  const focal = filter.focalLength ?? (fisheye ? 10 : filter.correction === "perspective" ? 16 : 14);
  const f = (focal / (36 / (filter.cropFactor ?? 1))) * bw;
  const scale = (filter.scale ?? 100) / 100;
  if (filter.correction === "full-spherical") {
    // The layer is an equirectangular 360° × 180° panorama; render a normal view into it.
    const yaw = ((filter.yaw ?? 0) * Math.PI) / 180;
    const pitch = ((filter.pitch ?? 0) * Math.PI) / 180;
    const [cp, sp, cyw, syw] = [Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)];
    return remapClear(r, (x, y, to) => {
      let [dx, dy, dz] = [(x - cx) / scale, (y - cy) / scale, f];
      [dy, dz] = [dy * cp - dz * sp, dy * sp + dz * cp];
      [dx, dz] = [dx * cyw + dz * syw, -dx * syw + dz * cyw];
      const lon = Math.atan2(dx, dz);
      const lat = Math.atan2(-dy, Math.sqrt(dx * dx + dz * dz));
      to[0] = bx + (((lon / (2 * Math.PI) + 0.5) % 1) + 1) % 1 * bw;
      to[1] = by + (0.5 - lat / Math.PI) * bh;
      return true;
    });
  }
  return remapClear(r, (x, y, to) => {
    const [dx, dy] = [(x - cx) / scale, (y - cy) / scale];
    const rOut = len(dx, dy);
    if (rOut < 1e-6) {
      to[0] = cx;
      to[1] = cy;
      return true;
    }
    let rIn: number;
    if (fisheye) {
      // Out: rectilinear (r = f tan θ). In: an equidistant fisheye (r = f θ).
      rIn = f * Math.atan(rOut / f);
    } else {
      // Out: stereographic (r = 2f tan θ/2), which keeps shapes at the edges. In: rectilinear.
      const theta = 2 * Math.atan(rOut / (2 * f));
      if (theta >= Math.PI / 2 - 1e-3) return false;
      rIn = f * Math.tan(theta);
    }
    to[0] = cx + (dx / rOut) * rIn;
    to[1] = cy + (dy / rOut) * rIn;
    return true;
  });
}

// ── Vanishing Point ──────────────────────────────────────────────────────────────────────

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

export function vanishingPoint(ctx: FilterCtx, r: Raster, filter: Of<"vanishing-point">): Raster {
  const { w, h } = r;
  const quad = filter.plane.map((p) => ctx.at(p as Point)) as [Point, Point, Point, Point];
  // The plane as a unit square: (u, v) in 0..1 maps to the image through the homography.
  const toImage = rectToQuad(1, 1, quad);
  const toPlane = invert3(toImage);
  const uv = new Float32Array(w * h * 2);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [u, v] = project(toPlane, [x + 0.5, y + 0.5]);
      uv[(y * w + x) * 2] = u;
      uv[(y * w + x) * 2 + 1] = v;
    }
  // How many plane units one pixel spans here, for soft edges of a pixel or so.
  const pixel = (i: number) => {
    const x = i % w;
    const j = x + 1 < w ? i + 1 : i - 1;
    return Math.max(1e-6, len(uv[j * 2]! - uv[i * 2]!, uv[j * 2 + 1]! - uv[i * 2 + 1]!));
  };
  const layer = planes(r);
  let rgb = layer.rgb;
  const a = layer.a;

  for (const stamp of filter.stamps ?? []) {
    // Clone Stamp in perspective: copy the patch around `from` to `to`; it shrinks and tilts with the plane.
    const radius = stamp.size / 2;
    const [du, dv] = [stamp.from[0] - stamp.to[0], stamp.from[1] - stamp.to[1]];
    const mask = new Float32Array(w * h);
    const fill = rgb.map((p) => p.slice());
    for (let i = 0; i < w * h; i++) {
      const [u, v] = [uv[i * 2]!, uv[i * 2 + 1]!];
      const d = len(u - stamp.to[0], v - stamp.to[1]) / radius;
      if (d >= 1) continue;
      mask[i] = smoothstep(1, 0.7, d);
      const [sx, sy] = project(toImage, [u + du, v + dv]);
      for (let c = 0; c < 3; c++) fill[c]![i] = samplePlane(rgb[c]!, w, h, sx, sy);
    }
    rgb = (stamp.heal ? heal(rgb, fill, mask, w, h) : rgb.map((p, c) => p.map((v, i) => v + (fill[c]![i]! - v) * mask[i]!))) as typeof rgb;
  }

  for (const paste of filter.paste ?? []) {
    const image = ctx.kit.images.get(paste.asset);
    if (!image) {
      ctx.kit.warnings.push(`vanishing point: image "${paste.asset}" isn't loaded`);
      continue;
    }
    const src = readRaster(ctx.kit.ck, image, false);
    const [u0, v0, u1, v1] = paste.rect ?? [0, 0, 1, 1];
    const tiles = paste.tile ?? 1;
    const opacity = paste.opacity ?? 1;
    const px = new Float32Array(4);
    for (let i = 0; i < w * h; i++) {
      const [u, v] = [uv[i * 2]!, uv[i * 2 + 1]!];
      const [s, t] = [(u - u0) / (u1 - u0), (v - v0) / (v1 - v0)];
      // Anti-aliased edges: coverage fades over about a pixel at the rectangle's sides.
      const edge = Math.min(s * (u1 - u0), t * (v1 - v0), (1 - s) * (u1 - u0), (1 - t) * (v1 - v0)) / pixel(i);
      if (edge <= -0.5) continue;
      const [ts, tt] = [s * tiles - Math.floor(s * tiles), t * tiles - Math.floor(t * tiles)];
      sample(src, clamp(ts, 0, 1) * src.w, clamp(tt, 0, 1) * src.h, px, 0);
      const cover = (px[3]! / 255) * clamp(edge + 0.5, 0, 1) * opacity;
      if (cover <= 0) continue;
      for (let c = 0; c < 3; c++) rgb[c]![i] = rgb[c]![i]! + (px[c]! / Math.max(px[3]!, 1e-6) - rgb[c]![i]!) * cover;
      a[i] = a[i]! + (255 - a[i]!) * cover;
    }
  }
  if (!filter.stamps?.length && !filter.paste?.length) ctx.kit.warnings.push("vanishing point: add stamps or paste to the plane");
  return fromPlanes(w, h, rgb, a);
}

// ── Render › Flame ───────────────────────────────────────────────────────────────────────

/** Fire colours by heat: dark red at the edges through orange and yellow to a white core. */
function fireColor(t: number, tint: Rgb | undefined): Rgb {
  const stops: Array<[number, Rgb]> = [
    [0, [0.55, 0.05, 0.02]],
    [0.35, [0.95, 0.3, 0.05]],
    [0.65, [1, 0.72, 0.2]],
    [0.88, [1, 0.95, 0.7]],
    [1, [1, 1, 0.95]],
  ];
  let c: Rgb = stops[stops.length - 1]![1];
  for (let s = 1; s < stops.length; s++)
    if (t <= stops[s]![0]) {
      const [[a, ca], [b, cb]] = [stops[s - 1]!, stops[s]!];
      const f = (t - a) / (b - a);
      c = [0, 1, 2].map((j) => ca[j]! + (cb[j]! - ca[j]!) * f) as Rgb;
      break;
    }
  return tint ? (c.map((v, j) => v * (0.35 + 0.65 * tint[j]!) + (t > 0.85 ? (t - 0.85) * 2 : 0)) as Rgb) : c;
}

export function flame(ctx: FilterCtx, r: Raster, filter: Of<"flame">): Raster {
  const { w, h } = r;
  const { k } = ctx;
  const type = filter.type ?? (filter.path.length > 1 ? "multiple" : "candle");
  const candle = type === "candle";
  const length = (filter.length ?? (ctx.minSide / k) * (candle ? 0.12 : 0.3)) * k;
  const width = filter.width !== undefined ? filter.width * k : length * (candle ? 0.23 : 0.35);
  const turb = (filter.turbulence ?? 30) / 100;
  const jag = (filter.jag ?? 30) / 100;
  const seed = filter.seed ?? 1;
  const tint = filter.color ? hex(filter.color) : undefined;
  const pts = filter.path.map((p) => ctx.at(p as Point));
  const heat = new Float32Array(w * h);
  const ang = (((filter.angle ?? 90) * Math.PI) / 180);
  const up: Point = [Math.cos(ang), -Math.sin(ang)];
  // A flame's heat at a point given how far along it (0 base, 1 tip) and across it (−1..1) it is.
  // Turbulence bends it; jag splits its top into separate licking tongues.
  const tongue = (s: number, q: number, gx: number, gy: number, id: number) => {
    if (s < -0.1 || s > 1.4) return 0;
    const f = length * 0.16;
    const n = fbm(gx / f + id * 3.7, gy / f + seed * 5.3 + s * 1.5, 3, seed);
    const lick = fbm(gx / (f * 0.45) + id * 1.9, gy / (f * 0.45) + s * 3, 2, seed + 7);
    const qq = q + ((n - 0.5) * 1.6 + (lick - 0.5) * 0.6) * turb * Math.max(0.15, s);
    const tips = 0.5 + 0.5 * Math.sin(qq * Math.PI * (1.5 + jag * 2) + n * 6);
    const sj = s + (lick - 0.5) * jag * 0.5 + tips * jag * 0.28 * clamp(s * 1.5, 0, 1);
    // Widest a quarter of the way up, closing to a point at the tip and rounding at the base.
    const profile = Math.max(0.02, Math.min(1, (sj + 0.1) * 3.5) * (1 - clamp(sj, 0, 1)) ** 0.7);
    const across = 1 - (qq / profile) ** 2;
    return across <= 0 ? 0 : across ** 0.55 * (1 - clamp(sj, 0, 1)) ** 0.5 * smoothstep(-0.1, 0.05, sj);
  };
  const lay = (base: Point, dir: Point, flameLen: number, flameWidth: number, id: number) => {
    const norm: Point = [-dir[1], dir[0]];
    const reach = flameLen * 1.2 + flameWidth;
    const [x0, x1] = [Math.max(0, Math.floor(base[0] - reach)), Math.min(w - 1, Math.ceil(base[0] + reach))];
    const [y0, y1] = [Math.max(0, Math.floor(base[1] - reach)), Math.min(h - 1, Math.ceil(base[1] + reach))];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const [px, py] = [x + 0.5 - base[0], y + 0.5 - base[1]];
        const v = tongue((px * dir[0] + py * dir[1]) / flameLen, (px * norm[0] + py * norm[1]) / (flameWidth / 2), x + ctx.ox, y + ctx.oy, id);
        // Overlapping flames feed each other.
        if (v > 0) heat[y * w + x] = Math.min(1, heat[y * w + x]! + v * (1 - heat[y * w + x]! * 0.6));
      }
  };
  if (type === "one" && pts.length > 1) {
    // One flame whose spine is the path, from its first point to its last.
    const segs = pts.slice(1).map((p, i) => [pts[i]!, p] as const);
    const total = segs.reduce((s, [a, b]) => s + len(b[0] - a[0], b[1] - a[1]), 0) || 1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let [best, along, side] = [Infinity, 0, 0];
        let run = 0;
        for (const [a, b] of segs) {
          const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
          const l2 = vx * vx + vy * vy || 1;
          const t = clamp(((x + 0.5 - a[0]) * vx + (y + 0.5 - a[1]) * vy) / l2, 0, 1);
          const [qx, qy] = [a[0] + vx * t - x - 0.5, a[1] + vy * t - y - 0.5];
          const d = len(qx, qy);
          if (d < best) [best, along, side] = [d, (run + t * Math.sqrt(l2)) / total, Math.sign(qx * vy - qy * vx) * d];
          run += Math.sqrt(l2);
        }
        heat[y * w + x] = tongue(along, side / (width / 2), x + ctx.ox, y + ctx.oy, 0);
      }
  } else if (candle) {
    lay(pts[0]!, up, length, width, 0);
  } else {
    // Flames every `interval` px along the path, each a little different in height.
    const interval = Math.max(1, filter.interval !== undefined ? filter.interval * k : width * 0.7);
    const bases: Point[] = pts.length === 1 ? [pts[0]!] : [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, b] = [pts[i]!, pts[i + 1]!];
      const l = len(b[0] - a[0], b[1] - a[1]) || 1;
      for (let d = i === 0 ? 0 : interval; d <= l; d += interval) bases.push([a[0] + ((b[0] - a[0]) * d) / l, a[1] + ((b[1] - a[1]) * d) / l]);
    }
    bases.forEach((p, i) => {
      // Each flame leans a little and burns to its own height.
      const lean = (hash(i, 2, seed) - 0.5) * 0.5;
      const dir: Point = [up[0] * Math.cos(lean) - up[1] * Math.sin(lean), up[0] * Math.sin(lean) + up[1] * Math.cos(lean)];
      lay(p, dir, length * (0.55 + hash(i, 0, seed) * 0.75), width * (0.75 + hash(i, 1, seed) * 0.5), i + 1);
    });
  }
  // Fire laid over the layer, with a warm glow lighting what's around it.
  const glowField = boxPlane(boxPlane(heat, w, h, width * 0.3), w, h, width * 0.3);
  const glowColor = tint ?? ([1, 0.45, 0.1] as Rgb);
  const out = { w, h, d: r.d.slice() };
  for (let i = 0; i < w * h; i++) {
    const t = heat[i]!;
    const halo = glowField[i]! * 0.35;
    if (t <= 0.01 && halo <= 0.005) continue;
    const c = fireColor(clamp(t * 1.1, 0, 1), tint);
    // Thin, cool fire at the edges is see-through; the hot core is solid.
    const cover = smoothstep(0, 0.55, t);
    const a = out.d[i * 4 + 3]!;
    const na = Math.max(a, cover * 255);
    for (let j = 0; j < 3; j++) {
      const under = a > 0 ? out.d[i * 4 + j]! / a : 0;
      const lit = 1 - (1 - under) * (1 - glowColor[j]! * halo);
      out.d[i * 4 + j] = clamp(lit + (c[j]! - lit) * cover, 0, 1) * na;
    }
    out.d[i * 4 + 3] = na;
  }
  return out;
}

// ── Render › Picture Frame ───────────────────────────────────────────────────────────────

const FRAME_COLORS: Record<NonNullable<Of<"picture-frame">["style"]>, string> = {
  flat: "#1E1E1E",
  bevel: "#3A3A3A",
  double: "#2B2B2B",
  wood: "#7A4A23",
  gold: "#C9A13B",
  stripes: "#22364F",
};

export function pictureFrame(ctx: FilterCtx, r: Raster, filter: Of<"picture-frame">): Raster {
  const { w, h } = r;
  const { k } = ctx;
  const style = filter.style ?? "bevel";
  const [bx, by, bw, bh] = boxPx(ctx);
  const margin = (filter.margin ?? 0) * k;
  const width = (filter.width ?? (Math.min(bw, bh) / k) * 0.06) * k;
  const base = hex(filter.color ?? FRAME_COLORS[style]);
  const { rgb, a } = planes(r);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const [lx, ly] = [x + 0.5 - bx, y + 0.5 - by];
      const sides = [ly, lx, bh - ly, bw - lx]; // top, left, bottom, right
      let side = 0;
      for (let s = 1; s < 4; s++) if (sides[s]! < sides[side]!) side = s;
      const d = sides[side]! - margin;
      if (d < -0.5) continue;
      const inner = d - width;
      if (inner > 0) {
        // A soft shadow the frame casts onto the picture.
        const shadow = 0.35 * Math.exp(-inner / Math.max(1, width * 0.12));
        for (let c = 0; c < 3; c++) rgb[c]![i]! *= 1 - shadow;
        continue;
      }
      const t = clamp(d / width, 0, 1);
      // Mitred corners come free: each pixel belongs to its nearest side. Light from the top left.
      const facing = side < 2 ? 1 : -1;
      const along = side % 2 === 0 ? lx : ly;
      let shade = 0;
      let color = base;
      if (style === "bevel" || style === "wood") shade = (t < 0.5 ? 1 : -1) * facing * 0.22;
      if (style === "double") {
        const band = t < 0.42 ? t / 0.42 : t > 0.58 ? (t - 0.58) / 0.42 : -1;
        if (band < 0) {
          color = base.map((v) => v + (1 - v) * 0.55) as Rgb;
          shade = -0.05;
        } else shade = (band < 0.5 ? 1 : -1) * facing * 0.2;
      }
      if (style === "wood") {
        const grain = Math.sin((t * 7 + fbm(along / (8 * k), t * 3 + side * 5, 3, 7) * 6) * Math.PI);
        shade += grain * 0.08 + (fbm(along / (2 * k), t * 20 + side, 2, 9) - 0.5) * 0.12;
      }
      if (style === "gold") {
        // Moulded ridges catching the light, with a bright edge on each.
        const ridge = Math.sin(t * Math.PI * 3);
        shade = ridge * facing * 0.25 + Math.max(0, Math.cos(t * Math.PI * 6)) ** 8 * 0.35 + (fbm(along / (3 * k), t * 8, 2, 11) - 0.5) * 0.1;
      }
      if (style === "stripes") {
        const stripe = Math.floor(t * 5) % 2;
        color = stripe ? (base.map((v) => v + (1 - v) * 0.6) as Rgb) : base;
      }
      const edge = clamp(d + 0.5, 0, 1);
      for (let c = 0; c < 3; c++) {
        const v = clamp(shade >= 0 ? color[c]! + (1 - color[c]!) * shade : color[c]! * (1 + shade), 0, 1);
        rgb[c]![i] = rgb[c]![i]! + (v - rgb[c]![i]!) * edge;
      }
      a[i] = a[i]! + (255 - a[i]!) * edge;
    }
  return fromPlanes(w, h, rgb, a);
}

// ── Render › Tree ────────────────────────────────────────────────────────────────────────

type TreeType = NonNullable<Of<"tree">["type"]>;
const TREES: Record<TreeType, { depth: number; spread: number; ratio: number; children: number; leaf: string; trunk: string; leafScale: number }> = {
  oak: { depth: 7, spread: 34, ratio: 0.74, children: 3, leaf: "#3F7A2B", trunk: "#4E3524", leafScale: 1 },
  maple: { depth: 7, spread: 28, ratio: 0.76, children: 3, leaf: "#4C8A2E", trunk: "#5A3D28", leafScale: 1.15 },
  pine: { depth: 4, spread: 80, ratio: 0.32, children: 2, leaf: "#21472A", trunk: "#4A3020", leafScale: 0.7 },
  willow: { depth: 6, spread: 26, ratio: 0.78, children: 3, leaf: "#7FA44A", trunk: "#4C3A28", leafScale: 0.8 },
  birch: { depth: 6, spread: 22, ratio: 0.76, children: 2, leaf: "#8AB348", trunk: "#E6E1D4", leafScale: 0.75 },
  bare: { depth: 7, spread: 32, ratio: 0.74, children: 3, leaf: "#3F7A2B", trunk: "#3E2C20", leafScale: 1 },
};

export function tree(ctx: FilterCtx, image: Image, filter: Of<"tree">): Image {
  const { ck } = ctx.kit;
  const [w, h] = [image.width(), image.height()];
  const type = filter.type ?? "oak";
  const spec = TREES[type];
  const bh = boxPx(ctx)[3];
  const base = ctx.at((filter.at as Point | undefined) ?? [0.5, 1]);
  const height = (filter.height ?? 0.8) * bh;
  const thickness = (filter.thickness ?? 100) / 100;
  const leafAmount = type === "bare" ? 0 : (filter.leaves ?? 80) / 100;
  const leafSize = ((filter.leafSize ?? 100) / 100) * spec.leafScale;
  const leafColor = hex(filter.leafColor ?? spec.leaf);
  const trunkColor = hex(filter.trunkColor ?? spec.trunk);
  const light = (((filter.light ?? 135) * Math.PI) / 180);
  const [lx, ly] = [Math.cos(light), -Math.sin(light)];
  let state = (filter.seed ?? 1) * 2654435761;
  const rand = () => ((state = (Math.imul(state ^ (state >>> 15), 2246822519) + 0x9e3779b9) | 0) >>> 0) / 4294967296;

  const surface = ck.MakeSurface(w, h);
  if (!surface) throw new Error("Could not allocate a render surface");
  const canvas = surface.getCanvas();
  canvas.drawImage(image, 0, 0);
  image.delete();
  const paint = new ck.Paint();
  paint.setAntiAlias(true);
  paint.setStyle(ck.PaintStyle.Fill);
  type Leaf = { x: number; y: number; size: number; angle: number; shade: number };
  const leaves: Leaf[] = [];
  const branches: Array<{ x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; w0: number; w1: number; depth: number }> = [];
  const trunkLen = height * (type === "pine" ? 1 : type === "willow" ? 0.4 : 0.36);
  const crownCenter: Point = [base[0], base[1] - height * (type === "pine" ? 0.5 : 0.62)];

  const grow = (x: number, y: number, angle: number, length: number, width: number, depth: number) => {
    // Willow strands arch out and then hang; everything else bends a little at random.
    const hanging = type === "willow" && depth >= 2;
    const a = hanging ? -Math.PI / 2 : angle + (rand() - 0.5) * 0.25;
    const [ex, ey] = hanging ? [x + Math.cos(angle) * length * 0.35, y + length * 0.95] : [x + Math.cos(a) * length, y - Math.sin(a) * length];
    const [cx, cy] = hanging
      ? [x + Math.cos(angle) * length * 0.45, y - length * 0.25]
      : [(x + ex) / 2 + (rand() - 0.5) * length * 0.15, (y + ey) / 2 + (rand() - 0.5) * length * 0.1];
    const tip = width * spec.ratio;
    branches.push({ x0: x, y0: y, x1: ex, y1: ey, cx, cy, w0: width, w1: tip, depth });
    const last = depth >= spec.depth;
    if (leafAmount > 0 && depth >= spec.depth - 2) {
      const count = Math.round((type === "pine" ? 14 : 6) * leafAmount * (last ? 1.5 : 0.6));
      for (let n = 0; n < count; n++) {
        const t = rand();
        const [px, py] = [x + (ex - x) * t + (rand() - 0.5) * length * 0.5, y + (ey - y) * t + (rand() - 0.5) * length * 0.5];
        // Leaves facing the light are lighter; those inside the crown, darker.
        const toward = ((px - crownCenter[0]) * lx + (py - crownCenter[1]) * ly) / (height * 0.4);
        leaves.push({ x: px, y: py, size: height * 0.022 * leafSize * (0.6 + rand() * 0.6), angle: rand() * Math.PI, shade: clamp(0.5 + toward * 0.45 + (rand() - 0.5) * 0.35, 0, 1) });
      }
    }
    if (last) return;
    if (type === "pine" && depth === 0) {
      // A straight leader with tiers of near-level branches, shorter towards the top.
      const tiers = 9;
      for (let t = 1; t <= tiers; t++) {
        const f = t / (tiers + 1);
        const [px, py] = [x + (ex - x) * (0.15 + f * 0.85), y + (ey - y) * (0.15 + f * 0.85)];
        const reach = height * 0.42 * (1 - f) ** 1.1 + height * 0.04;
        for (const side of [-1, 1]) grow(px, py, Math.PI / 2 + side * (1.25 + rand() * 0.2), reach, width * 0.35 * (1 - f * 0.6), 2);
      }
      return;
    }
    const children = spec.children - (rand() < 0.35 ? 1 : 0) + (depth < 2 && rand() < 0.4 ? 1 : 0);
    const spread = ((hanging ? 10 : spec.spread) * Math.PI) / 180;
    for (let n = 0; n < children; n++) {
      const f = children === 1 ? 0 : n / (children - 1) - 0.5;
      grow(ex, ey, a + f * spread * 2 + (rand() - 0.5) * spread * 0.5, length * (spec.ratio + (rand() - 0.5) * 0.12), tip * (0.75 + rand() * 0.2), depth + 1);
    }
  };
  grow(base[0], base[1], Math.PI / 2 + (rand() - 0.5) * 0.1, trunkLen, height * 0.045 * thickness * (type === "birch" ? 0.7 : 1), 0);

  // Branches, thick to thin, each a tapered curve shaded across from the light.
  branches.sort((p, q) => p.depth - q.depth);
  for (const b of branches) {
    const [dx, dy] = [b.x1 - b.x0, b.y1 - b.y0];
    const l = len(dx, dy) || 1;
    const [nx, ny] = [-dy / l, dx / l];
    const path = new ck.Path();
    path.moveTo(b.x0 + nx * b.w0 / 2, b.y0 + ny * b.w0 / 2);
    path.quadTo(b.cx + nx * (b.w0 + b.w1) / 4, b.cy + ny * (b.w0 + b.w1) / 4, b.x1 + nx * b.w1 / 2, b.y1 + ny * b.w1 / 2);
    path.lineTo(b.x1 - nx * b.w1 / 2, b.y1 - ny * b.w1 / 2);
    path.quadTo(b.cx - nx * (b.w0 + b.w1) / 4, b.cy - ny * (b.w0 + b.w1) / 4, b.x0 - nx * b.w0 / 2, b.y0 - ny * b.w0 / 2);
    path.close();
    const lit = 0.85 + (nx * lx + ny * ly) * 0.15;
    paint.setColor(ck.Color4f(trunkColor[0] * lit, trunkColor[1] * lit, trunkColor[2] * lit, 1));
    canvas.drawPath(path, paint);
    path.delete();
    if (type === "birch" && b.depth <= 2 && b.w0 > 3) {
      // Birch bark: short dark marks across the white trunk.
      for (let m = 0; m < l / (b.w0 * 0.8); m++) {
        const t = rand();
        const [mx, my] = [b.x0 + dx * t, b.y0 + dy * t];
        paint.setColor(ck.Color4f(0.12, 0.11, 0.1, 0.85));
        canvas.drawRect(ck.LTRBRect(mx - b.w0 * 0.3, my - b.w0 * 0.06, mx + b.w0 * (rand() * 0.3), my + b.w0 * 0.06), paint);
      }
    }
  }
  // Leaves, darkest first so the lit ones sit on top.
  leaves.sort((p, q) => p.shade - q.shade);
  for (const leaf of leaves) {
    const s = 0.55 + leaf.shade * 0.7;
    paint.setColor(ck.Color4f(clamp(leafColor[0] * s, 0, 1), clamp(leafColor[1] * s, 0, 1), clamp(leafColor[2] * s, 0, 1), 0.95));
    canvas.save();
    canvas.translate(leaf.x, leaf.y);
    canvas.rotate((leaf.angle * 180) / Math.PI, 0, 0);
    const [lw, lh] = type === "pine" ? [leaf.size * 1.6, leaf.size * 0.35] : type === "willow" ? [leaf.size * 1.4, leaf.size * 0.4] : [leaf.size, leaf.size * 0.62];
    canvas.drawOval(ck.LTRBRect(-lw / 2, -lh / 2, lw / 2, lh / 2), paint);
    canvas.restore();
  }
  paint.delete();
  const out = surface.makeImageSnapshot();
  surface.dispose();
  return out;
}

// ── Render › Relight ─────────────────────────────────────────────────────────────────────

export function relight(ctx: FilterCtx, r: Raster, filter: Of<"relight">): Raster {
  const { w, h } = r;
  const { k } = ctx;
  const [bx, by, bw, bh] = boxPx(ctx);
  const { rgb, a } = planes(r);
  // The surface: a depth map when given (white is near), otherwise the photo's own tones, smoothed
  // so the light follows forms rather than texture.
  let height: Float32Array;
  const depth = filter.depth ? ctx.kit.images.get(filter.depth) : undefined;
  if (filter.depth && !depth) ctx.kit.warnings.push(`relight: depth map "${filter.depth}" isn't loaded`);
  if (depth) {
    const d = readRaster(ctx.kit.ck, depth, false);
    const px = new Float32Array(4);
    height = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        sample(d, clamp((x + 0.5 - bx) / bw, 0, 1) * d.w, clamp((y + 0.5 - by) / bh, 0, 1) * d.h, px, 0);
        height[y * w + x] = px[3]! > 0 ? (px[0]! * 0.299 + px[1]! * 0.587 + px[2]! * 0.114) / px[3]! : 0;
      }
  } else {
    const sigma = (3 + (filter.smoothness ?? 50) * 0.35) * k;
    const rr = Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5;
    const L = luma(rgb, w * h);
    height = boxPlane(boxPlane(boxPlane(L, w, h, rr), w, h, rr), w, h, rr);
  }
  const big = Math.max(bw, bh);
  const relief = big * 0.15;
  const lights = filter.lights.map((l) => {
    const [x, y] = ctx.at(l.at as Point);
    return { x, y, z: (l.height ?? 0.35) * big, color: hex(l.color ?? "#FFF4E0"), power: l.intensity ?? 1, reach: (l.radius ?? 0.8) * big };
  });
  const keep = 1 + (filter.ambient ?? -30) / 100;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const gx = (height[y * w + Math.min(w - 1, x + 1)]! - height[y * w + Math.max(0, x - 1)]!) * 0.5 * relief;
      const gy = (height[Math.min(h - 1, y + 1) * w + x]! - height[Math.max(0, y - 1) * w + x]!) * 0.5 * relief;
      const nl = len(len(gx, gy), 1);
      const [nx, ny, nz] = [-gx / nl, -gy / nl, 1 / nl];
      const z = height[i]! * relief;
      const add: Rgb = [0, 0, 0];
      for (const l of lights) {
        const [dx, dy, dz] = [l.x - x - 0.5, l.y - y - 0.5, l.z - z];
        const d = len(len(dx, dy), dz) || 1;
        const lambert = Math.max(0, (nx * dx + ny * dy + nz * dz) / d);
        const fall = clamp(1 - len(dx, dy) / l.reach, 0, 1) ** 2;
        // A touch of shine where the surface faces both the light and the viewer.
        const [hx, hy, hz] = [dx / d, dy / d, dz / d + 1];
        const hl = len(len(hx, hy), hz) || 1;
        const spec = Math.max(0, (nx * hx + ny * hy + nz * hz) / hl) ** 30 * 0.25;
        for (let c = 0; c < 3; c++) add[c]! += (lambert * 0.8 + spec) * fall * l.power * l.color[c]!;
      }
      for (let c = 0; c < 3; c++) rgb[c]![i] = rgb[c]![i]! * (keep + add[c]!) + (add[c]! > 1 ? (add[c]! - 1) * 0.1 : 0);
    }
  return fromPlanes(w, h, rgb, a);
}

