import type { Filter } from "@gesso/core";
import { boxPlane, clamp, fbm, fromPlanes, gaussBlur, guided, hash, luma, morph, planes, samplePlane, smoothstep, softKuwahara, type Raster } from "./cpu.js";

// Filter Gallery: Photoshop's Artistic, Brush Strokes, Sketch and Texture filters, built from a few
// shared pieces: strokes (noise smeared along a direction), surfaces (canvas, burlap, brick,
// sandstone height maps), relief (lighting a height map), inks (the Sketch filters' foreground and
// background colours) and cells (Voronoi, for cracks and glass). Parameters keep Photoshop's names
// and ranges; one unit of a size is about one artboard pixel, scaled by the render scale `k`.
// Patterns are anchored to the artboard, so they don't crawl as a layer moves.

export const GALLERY_KINDS = [
  "colored-pencil",
  "dry-brush",
  "film-grain",
  "fresco",
  "neon-glow",
  "paint-daubs",
  "palette-knife",
  "plastic-wrap",
  "rough-pastels",
  "smudge-stick",
  "sponge",
  "underpainting",
  "watercolor",
  "accented-edges",
  "angled-strokes",
  "crosshatch",
  "dark-strokes",
  "ink-outlines",
  "spatter",
  "sprayed-strokes",
  "sumi-e",
  "bas-relief",
  "chalk-charcoal",
  "charcoal",
  "chrome",
  "conte-crayon",
  "graphic-pen",
  "note-paper",
  "photocopy",
  "plaster",
  "reticulation",
  "stamp",
  "torn-edges",
  "water-paper",
  "craquelure",
  "grain",
  "mosaic-tiles",
  "patchwork",
  "stained-glass",
  "texturizer",
] as const;
export type GalleryFilter = Extract<Filter, { kind: (typeof GALLERY_KINDS)[number] }>;

/** Where the filter runs: the render scale and the image's offset on the artboard (output px). */
export type GalleryCtx = { k: number; ox: number; oy: number };

type Planes = [Float32Array, Float32Array, Float32Array];
type Rgb = [number, number, number];
type Dir = "horizontal" | "vertical" | "right-diagonal" | "left-diagonal";
type Light = "top" | "top-right" | "right" | "bottom-right" | "bottom" | "bottom-left" | "left" | "top-left";

export function gallery(g: GalleryCtx, r: Raster, filter: GalleryFilter): Raster {
  const { w, h } = r;
  const { rgb, a } = planes(r);
  const L = luma(rgb, w * h);
  const out = (p: ArrayLike<number>[]) => fromPlanes(w, h, p, a);
  const k = g.k;
  switch (filter.kind) {
    // ── Artistic ─────────────────────────────────────────────────────────────────────────
    case "colored-pencil": {
      // Coloured hatching over grey paper: darker areas take more strokes; edges are drawn in.
      const pressure = (filter.pressure ?? 8) / 15;
      const paper = 0.55 + 0.45 * ((filter.paper ?? 25) / 50);
      const hatch = strokes(g, w, h, "right-diagonal", (filter.width ?? 4) * 1.5 * k, 11);
      const e = sobel(L, w, h, k);
      return out(
        rgb.map((p) => {
          const o = new Float32Array(w * h);
          for (let i = 0; i < w * h; i++) {
            const m = clamp((1 - L[i]!) * (0.9 + pressure) + (hatch[i]! - 0.5) * 1.3 - 0.15, 0, 1);
            const ink = clamp(p[i]! * 0.92 - e[i]! * 0.5 * pressure, 0, 1);
            o[i] = paper * (1 - m) + ink * m;
          }
          return o;
        }),
      );
    }
    case "dry-brush":
    case "fresco": {
      const size = (filter.size ?? 2) + 1;
      const detail = filter.detail ?? 8;
      const painted = planes(softKuwahara(r, size * (filter.kind === "fresco" ? 1.6 : 1.1) * k)).rgb;
      const n = noise(g, w, h, 13);
      const rough = (filter.roughness ?? 1) * 0.035;
      if (filter.kind === "dry-brush") {
        // Flattened strokes with fewer colours, and a dry, grainy texture.
        const levels = 5 + detail;
        return out(painted.map((p) => p.map((v, i) => Math.round(v * levels) / levels + (n[i]! - 0.5) * rough * 2)));
      }
      // Fresco: short coarse strokes, high contrast, with dark outlines.
      const PL = luma(painted, w * h);
      const e = sobel(PL, w, h, k);
      const darken = 0.75 - detail * 0.02;
      return out(painted.map((p) => p.map((v, i) => ((v - 0.5) * 1.45 + 0.42) * (1 - e[i]! * darken) + (n[i]! - 0.5) * rough * 2)));
    }
    case "film-grain": {
      // Even grain, strongest in the mid-tones and shadows, and a soft glow in the highlights.
      const grain = ((filter.grain ?? 4) / 20) * 0.4;
      const glow = (filter.intensity ?? 10) / 10;
      const t = 1 - ((filter.highlight ?? 0) / 20) * 0.7;
      const n = noise(g, w, h, 17);
      return out(
        rgb.map((p) =>
          p.map((v, i) => {
            const l = L[i]!;
            const hl = (filter.highlight ?? 0) > 0 ? smoothstep(t - 0.15, t + 0.05, l) * glow : 0;
            const grained = v + (n[i]! - 0.5) * grain * (1.2 - l);
            return grained + (1 - grained) * hl * 0.7;
          }),
        ),
      );
    }
    case "neon-glow": {
      // The image in two inks, with a coloured glow in its highlights (or its shadows when size < 0).
      const [fg, bg] = inks(filter.colors);
      const glowColor = hex(filter.color ?? "#4E9BFF");
      const size = filter.size ?? 5;
      const strength = ((filter.brightness ?? 15) / 50) * 1.6;
      const source = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) source[i] = size >= 0 ? smoothstep(0.45, 0.95, L[i]!) : smoothstep(0.55, 0.05, L[i]!);
      const glow = blurPlane(source, w, h, Math.max(1, Math.abs(size)) * 0.8 * k);
      return out([0, 1, 2].map((c) => L.map((l, i) => fg[c]! + (bg[c]! - fg[c]!) * l * 0.85 + glowColor[c]! * glow[i]! * strength)));
    }
    case "paint-daubs": {
      const size = filter.size ?? 8;
      const brush = filter.brush ?? "simple";
      const wide = brush === "wide-sharp" || brush === "wide-blurry";
      let painted = softKuwahara(r, (size * (wide ? 0.9 : 0.55) + 1) * k);
      if (brush === "wide-blurry") painted = gaussBlur(painted, size * 0.25 * k);
      if (brush === "light-rough" || brush === "dark-rough") {
        const rough = planes(morph(painted, Math.max(1, size * 0.12 * k), brush === "light-rough")).rgb;
        const base = planes(painted).rgb;
        const n = noise(g, w, h, 19, 2 * k);
        painted = fromPlanes(w, h, base.map((p, c) => p.map((v, i) => v + (rough[c]![i]! - v) * (0.35 + n[i]! * 0.5))), a);
      }
      const sharp = ((filter.sharpness ?? 7) / 40) * (brush === "wide-sharp" ? 3 : brush === "wide-blurry" ? 0.5 : 2);
      const base = planes(painted).rgb;
      const soft = planes(gaussBlur(painted, Math.max(1, size * 0.3) * k)).rgb;
      const n = brush === "sparkle" ? noise(g, w, h, 23) : undefined;
      return out(
        base.map((p, c) =>
          p.map((v, i) => {
            const s = v + (v - soft[c]![i]!) * sharp;
            return n && n[i]! > 0.985 ? s + (1 - s) * L[i]! : s;
          }),
        ),
      );
    }
    case "palette-knife": {
      // Flat knife-laid patches: few colours, broad shapes, softened by `softness`.
      const size = filter.size ?? 25;
      let painted = softKuwahara(r, (size * 0.22 + 1) * k);
      const levels = 3 + (filter.detail ?? 3) * 3;
      if ((filter.softness ?? 0) > 0) painted = gaussBlur(painted, (filter.softness ?? 0) * 0.4 * k);
      return out(planes(painted).rgb.map((p) => p.map((v) => Math.round(v * levels) / levels)));
    }
    case "plastic-wrap": {
      // A shiny film over the image's shapes: specular highlights from its smoothed tones.
      const height = blurPlane(L, w, h, ((filter.smoothness ?? 7) * 0.6 + 1) * k);
      const depth = ((filter.detail ?? 9) / 9) * 60 * k;
      const spec = new Float32Array(w * h);
      const [lx, ly, lz] = lightVector("top-left");
      const [hx, hy, hz] = normalize(lx, ly, lz + 1);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const gx = (height[y * w + Math.min(w - 1, x + 1)]! - height[y * w + Math.max(0, x - 1)]!) * 0.5 * depth;
          const gy = (height[Math.min(h - 1, y + 1) * w + x]! - height[Math.max(0, y - 1) * w + x]!) * 0.5 * depth;
          const [nx, ny, nz] = normalize(-gx, -gy, 1);
          spec[y * w + x] = Math.max(0, nx * hx + ny * hy + nz * hz) ** 40;
        }
      const strength = ((filter.highlight ?? 15) / 20) * 1.4;
      return out(rgb.map((p) => p.map((v, i) => v * 0.9 + spec[i]! * strength)));
    }
    case "rough-pastels":
    case "underpainting": {
      let base: Planes;
      if (filter.kind === "rough-pastels") {
        // Chalky strokes along the diagonal; `detail` keeps more of the original.
        const smeared = rgb.map((p) => lineBlur(p, w, h, "right-diagonal", ((filter.length ?? 6) + 1) * 0.5 * k)) as Planes;
        const keep = 0.25 + ((filter.detail ?? 4) / 20) * 0.5;
        const s = strokes(g, w, h, "right-diagonal", ((filter.length ?? 6) + 2) * k, 29);
        base = smeared.map((p, c) => p.map((v, i) => (v + (rgb[c]![i]! - v) * keep) * 1.06 + (s[i]! - 0.5) * 0.18)) as Planes;
      } else {
        // A soft, blurred painting under the image, `coverage` deciding how much of it shows.
        const soft = planes(gaussBlur(r, ((filter.size ?? 6) * 0.6 + 1) * k)).rgb;
        const cover = 0.45 + ((filter.coverage ?? 16) / 40) * 0.5;
        base = soft.map((p, c) => p.map((v, i) => rgb[c]![i]! + (v - rgb[c]![i]!) * cover)) as Planes;
      }
      return out(textured(g, base, w, h, filter, filter.kind === "rough-pastels" ? 20 : 4));
    }
    case "smudge-stick": {
      // Dark areas smear along the diagonal; highlights brighten and lose detail.
      const smeared = rgb.map((p) => lineBlur(p, w, h, "right-diagonal", ((filter.length ?? 2) + 1) * 2 * k));
      const t = 1 - ((filter.highlight ?? 0) / 20) * 0.7;
      const glow = (filter.intensity ?? 10) / 10;
      return out(
        rgb.map((p, c) =>
          p.map((v, i) => {
            const s = Math.min(v, smeared[c]![i]!) * 0.85 + smeared[c]![i]! * 0.15;
            const mixed = v + (s - v) * (1 - L[i]!) * 1.4;
            const hl = (filter.highlight ?? 0) > 0 ? smoothstep(t - 0.15, t + 0.05, L[i]!) * glow : 0;
            return mixed + (1 - mixed) * hl * 0.6;
          }),
        ),
      );
    }
    case "sponge": {
      // A soft image dabbed with a sponge: dark, blotchy holes in a coarse pattern.
      const size = (filter.size ?? 2) + 2;
      const soft = planes(gaussBlur(r, size * 0.6 * k)).rgb;
      const scale = (size * 0.6 + 1) * k;
      const blot = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) blot[y * w + x] = fbm((x + g.ox) / scale, (y + g.oy) / scale, 3, 31);
      const smooth = blurPlane(blot, w, h, (filter.smoothness ?? 5) * 0.12 * k);
      const def = ((filter.definition ?? 12) / 25) * 0.55;
      // The sponge's holes print darker where the image is dark, and barely show in the highlights.
      return out(soft.map((p) => p.map((v, i) => v * (1 - smoothstep(0.5, 0.68, smooth[i]!) * def * (1.15 - L[i]! * 0.7)))));
    }
    case "watercolor": {
      // Simplified washes, more saturated, with pigment pooling darker at their edges.
      const detail = filter.detail ?? 9;
      const washes = planes(guided(softKuwahara(r, ((15 - detail) * 0.35 + 1) * k), 2 * k, 0.004)).rgb;
      const WL = luma(washes, w * h);
      const e = sobel(WL, w, h, k);
      const shadow = (filter.shadow ?? 1) / 10;
      const n = fbmPlane(g, w, h, 6 * k, 37);
      const rough = (filter.roughness ?? 1) * 0.03;
      return out(
        washes.map((p) =>
          p.map((v, i) => {
            const l = WL[i]!;
            const sat = l + (v - l) * 1.25;
            return sat * (1 - e[i]! * (0.45 + shadow * 0.5)) * (1 - shadow * 0.15) + (n[i]! - 0.5) * rough * 2;
          }),
        ),
      );
    }
    // ── Brush Strokes ────────────────────────────────────────────────────────────────────
    case "accented-edges": {
      // Edges traced in light (high brightness) or ink (low) over a smoothed image.
      const smooth = planes(guided(r, ((filter.smoothness ?? 5) * 0.4 + 1) * k, 0.01)).rgb;
      const e = blurPlane(sobel(luma(smooth, w * h), w, h, (filter.width ?? 2) * 0.6 * k), w, h, 0.5 * k).map((v) => Math.min(1, v * 2.5));
      const b = ((filter.brightness ?? 38) - 25) / 25;
      return out(smooth.map((p) => p.map((v, i) => (b >= 0 ? v + (1 - v) * e[i]! * b * 1.5 : v * (1 + e[i]! * b * 1.5)))));
    }
    case "angled-strokes": {
      // Light areas painted in strokes one way, dark areas the other.
      const len = (filter.length ?? 15) * 0.22 * k;
      const one = rgb.map((p) => lineBlur(p, w, h, "right-diagonal", len));
      const other = rgb.map((p) => lineBlur(p, w, h, "left-diagonal", len));
      const balance = (filter.balance ?? 50) / 100;
      const sharp = ((filter.sharpness ?? 3) / 10) * 1.2;
      const s = strokes(g, w, h, "right-diagonal", len, 41);
      return out(
        rgb.map((p, c) =>
          p.map((v, i) => {
            const t = smoothstep(balance - 0.15, balance + 0.15, L[i]!);
            const stroked = other[c]![i]! + (one[c]![i]! - other[c]![i]!) * t;
            return stroked + (v - stroked) * sharp * 0.5 + (s[i]! - 0.5) * 0.14;
          }),
        ),
      );
    }
    case "crosshatch": {
      // Pencil hatching in both diagonals over the image, which keeps its detail.
      const len = (filter.length ?? 9) * 0.6 * k;
      const one = strokes(g, w, h, "right-diagonal", len, 43);
      const other = strokes(g, w, h, "left-diagonal", len, 47);
      const strength = (filter.strength ?? 1) * 0.22;
      const soft = rgb.map((p) => blurPlane(p, w, h, k));
      const sharp = ((filter.sharpness ?? 6) / 20) * 1.5;
      return out(rgb.map((p, c) => p.map((v, i) => v + (v - soft[c]![i]!) * sharp + (one[i]! + other[i]! - 1) * strength * (1.1 - L[i]! * 0.6))));
    }
    case "dark-strokes": {
      // Dark areas in short, tight dark strokes; light areas in long white ones.
      const short = rgb.map((p) => lineBlur(p, w, h, "left-diagonal", 3 * k));
      const long = rgb.map((p) => lineBlur(p, w, h, "right-diagonal", 9 * k));
      const split = 0.25 + ((filter.balance ?? 5) / 10) * 0.5;
      const [black, white] = [(filter.black ?? 6) / 10, (filter.white ?? 2) / 10];
      return out(
        rgb.map((_, c) =>
          L.map((l, i) => {
            const dark = short[c]![i]! * (1 - black * 0.75);
            const light = long[c]![i]! + (1 - long[c]![i]!) * white * 0.6;
            return dark + (light - dark) * smoothstep(split - 0.1, split + 0.1, l);
          }),
        ),
      );
    }
    case "ink-outlines": {
      // Fine ink lines over the detail, with darker shadows and lighter highlights.
      const len = (filter.length ?? 4) * 0.6 * k;
      const smear = rgb.map((p, c) => {
        const one = lineBlur(p, w, h, c % 2 ? "left-diagonal" : "right-diagonal", len);
        return one.map((v, i) => (v + p[i]!) / 2);
      });
      const e = sobel(L, w, h, k);
      const [dark, light] = [(filter.dark ?? 20) / 50, (filter.light ?? 10) / 50];
      return out(smear.map((p) => p.map((v, i) => (v * (1 - (1 - L[i]!) * dark * 0.8) + L[i]! * light * 0.35) * (1 - e[i]! * 0.85))));
    }
    case "spatter":
    case "sprayed-strokes": {
      // An airbrush's spatter: pixels scattered by up to `radius`, softened by `smoothness`.
      let src = rgb;
      if (filter.kind === "sprayed-strokes") src = rgb.map((p) => lineBlur(p, w, h, filter.direction ?? "right-diagonal", ((filter.length ?? 12) + 1) * 0.28 * k)) as Planes;
      const radius = (filter.radius ?? (filter.kind === "spatter" ? 10 : 7)) * (filter.kind === "spatter" ? 0.6 : 0.45) * k;
      const smoothness = filter.kind === "spatter" ? (filter.smoothness ?? 5) : 3;
      return out(scatter(g, src, w, h, radius, smoothness * 0.25 * k));
    }
    case "sumi-e": {
      // Japanese ink on rice paper: soft, rich blacks soaking into strokes.
      const soft = planes(gaussBlur(r, (filter.width ?? 10) * 0.1 * k)).rgb;
      const SL = luma(soft, w * h);
      const stroke = lineBlur(SL, w, h, "right-diagonal", (filter.width ?? 10) * 0.3 * k);
      const pressure = (filter.pressure ?? 2) / 15;
      const contrast = 1 + (filter.contrast ?? 16) / 40;
      return out(
        soft.map((p) =>
          p.map((v, i) => {
            const ink = clamp((0.45 + pressure * 0.2 - stroke[i]!) * 2.5, 0, 1);
            return ((v * (1 - ink * 0.85)) - 0.5) * contrast + 0.5;
          }),
        ),
      );
    }
    // ── Sketch ───────────────────────────────────────────────────────────────────────────
    case "bas-relief": {
      // Carved low relief: the image's shapes lit from one side, in the two inks.
      const [fg, bg] = inks(filter.colors);
      const height = blurPlane(L, w, h, ((filter.smoothness ?? 3) * 0.5 + 0.5) * k);
      const shade = relief(height, w, h, filter.light ?? "bottom", ((filter.detail ?? 13) / 15) * 14 * k);
      return out(twoTone(fg, bg, L.map((l, i) => clamp(0.55 + shade[i]! * 1.6 + (l - 0.5) * 0.3, 0, 1))));
    }
    case "chalk-charcoal": {
      // Mid-tones a flat grey; shadows in diagonal charcoal strokes, highlights in chalk.
      const [fg, bg] = inks(filter.colors);
      const s = strokes(g, w, h, "right-diagonal", 5 * k, 53);
      const pressure = 0.5 + (filter.pressure ?? 1) * 0.25;
      const [coal, chalk] = [(filter.charcoal ?? 6) / 20, (filter.chalk ?? 6) / 20];
      return out(
        [0, 1, 2].map((c) =>
          L.map((l, i) => {
            const grey = (fg[c]! + bg[c]!) / 2;
            const dark = clamp((0.25 + coal * 0.4 - l) * 4 + (s[i]! - 0.5) * pressure * 2, 0, 1);
            const light = clamp((l - 0.75 + chalk * 0.4) * 4 + (0.5 - s[i]!) * pressure * 2, 0, 1);
            return grey + (fg[c]! - grey) * dark + (bg[c]! - grey) * light;
          }),
        ),
      );
    }
    case "charcoal": {
      // Bold diagonal smudges in the foreground colour on the background colour, edges drawn in.
      const [fg, bg] = inks(filter.colors);
      const s = strokes(g, w, h, "right-diagonal", (3 + (filter.thickness ?? 1) * 1.5) * k, 59);
      const e = sobel(L, w, h, k);
      const detail = (filter.detail ?? 5) / 5;
      const split = (filter.balance ?? 50) / 100;
      return out(twoTone(fg, bg, L.map((l, i) => 1 - clamp((split - l) * 3 + 0.4 + (s[i]! - 0.5) * 1.2 + e[i]! * detail * 1.2, 0, 1))));
    }
    case "chrome": {
      // Polished chrome: the smoothed tones folded into bright and dark metallic bands.
      const soft = blurPlane(L, w, h, ((filter.smoothness ?? 7) * 0.6 + 1) * k);
      const bands = 1.5 + (filter.detail ?? 4) * 0.35;
      const shade = relief(soft, w, h, "top-left", 20 * k);
      const v = soft.map((l, i) => clamp(0.5 - 0.5 * Math.cos(l * Math.PI * 2 * bands) + shade[i]! * 0.8, 0, 1));
      return out([v, v, v]);
    }
    case "conte-crayon": {
      // Dark areas in the foreground colour, light areas in the background colour, on a texture.
      const [fg, bg] = inks(filter.colors);
      const f = (filter.foreground ?? 11) / 15;
      const b = (filter.background ?? 7) / 15;
      const t = L.map((l) => smoothstep(0.5 - f * 0.4, 0.5 + (1 - b) * 0.4, l));
      return out(textured(g, twoTone(fg, bg, t), w, h, { ...filter, texture: filter.texture ?? "canvas" }, 4));
    }
    case "graphic-pen": {
      // Fine ink lines in one direction, denser where the image is dark.
      const [fg, bg] = inks(filter.colors);
      const s = strokes(g, w, h, filter.direction ?? "right-diagonal", (filter.length ?? 15) * 0.4 * k, 61, 1);
      const split = (filter.balance ?? 50) / 100;
      // Even the darkest areas keep slivers of paper between the lines.
      return out(twoTone(fg, bg, L.map((l, i) => smoothstep(-0.05, 0.05, (l - split) * 1.05 + (s[i]! - 0.5) * 0.85))));
    }
    case "note-paper": {
      // Embossed handmade paper: dark areas cut through to the paper beneath, with grain.
      const [fg, bg] = inks(filter.colors);
      const split = (filter.balance ?? 25) / 50;
      const soft = blurPlane(L, w, h, k);
      const top = soft.map((l) => smoothstep(split - 0.04, split + 0.04, l));
      const shade = relief(blurPlane(top, w, h, 1.5 * k), w, h, "top-left", ((filter.relief ?? 11) / 25) * 12 * k);
      const n = noise(g, w, h, 67);
      const grain = ((filter.graininess ?? 10) / 20) * 0.12;
      const upper: Rgb = [0, 1, 2].map((c) => fg[c]! + (bg[c]! - fg[c]!) * 0.88) as Rgb;
      const lower: Rgb = [0, 1, 2].map((c) => fg[c]! + (bg[c]! - fg[c]!) * 0.45) as Rgb;
      return out([0, 1, 2].map((c) => top.map((t, i) => lower[c]! + (upper[c]! - lower[c]!) * t + shade[i]! * 0.9 + (n[i]! - 0.5) * grain)));
    }
    case "photocopy": {
      // Edges and dark detail kept as toner; flat areas wash out to paper.
      const [fg, bg] = inks(filter.colors);
      const local = blurPlane(L, w, h, (25 - (filter.detail ?? 7)) * 0.5 * k);
      const dark = (filter.darkness ?? 8) / 50;
      return out(twoTone(fg, bg, L.map((l, i) => 1 - clamp((local[i]! - l) * (4 + dark * 30) + (0.35 - l) * dark * 1.5, 0, 1))));
    }
    case "plaster": {
      // Moulded plaster: dark areas raised, lit from one side.
      const [fg, bg] = inks(filter.colors);
      const split = (filter.balance ?? 20) / 50;
      const soft = blurPlane(L, w, h, ((filter.smoothness ?? 2) * 0.6 + 1) * k);
      const raised = blurPlane(soft.map((l) => 1 - smoothstep(split - 0.08, split + 0.08, l)), w, h, 1.5 * k);
      const shade = relief(raised, w, h, filter.light ?? "top", 18 * k);
      return out(twoTone(fg, bg, raised.map((t, i) => clamp(0.75 - t * 0.35 + shade[i]! * 1.4, 0, 1))));
    }
    case "reticulation": {
      // The clumped grain of reticulated film emulsion: shadows in clumps, highlights lightly grained.
      const [fg, bg] = inks(filter.colors);
      const clumps = blurPlane(noise(g, w, h, 71), w, h, 0.6 * k);
      const density = 0.4 + ((filter.density ?? 12) / 50) * 1.6;
      const [fgl, bgl] = [(filter.foreground ?? 40) / 50, (filter.background ?? 5) / 50];
      return out(twoTone(fg, bg, L.map((l, i) => clamp((l - 0.5 + (clumps[i]! - 0.5) * density) * 4 + 0.5 - fgl * 0.3 + bgl * 0.3, 0, 1))));
    }
    case "stamp": {
      // A rubber or wooden stamp: a smoothed, hard-edged split into the two inks.
      const [fg, bg] = inks(filter.colors);
      const soft = blurPlane(L, w, h, (filter.smoothness ?? 5) * 0.4 * k);
      const split = (filter.balance ?? 25) / 50;
      return out(twoTone(fg, bg, soft.map((l) => smoothstep(split - 0.03, split + 0.03, l))));
    }
    case "torn-edges": {
      // Ragged, torn-paper edges between the two inks.
      const [fg, bg] = inks(filter.colors);
      const smooth = filter.smoothness ?? 11;
      const soft = blurPlane(L, w, h, smooth * 0.2 * k);
      const n = fbmPlane(g, w, h, 2.5 * k, 73);
      const split = (filter.balance ?? 25) / 50;
      const contrast = (filter.contrast ?? 17) * 1.5;
      return out(twoTone(fg, bg, soft.map((l, i) => clamp((l + (n[i]! - 0.5) * (0.06 + (16 - smooth) * 0.02) - split) * contrast + 0.5, 0, 1))));
    }
    case "water-paper": {
      // Colours blotted into damp, fibrous paper.
      const len = (filter.length ?? 15) * 0.4 * k;
      const across = rgb.map((p) => lineBlur(p, w, h, "horizontal", len));
      const down = rgb.map((p) => lineBlur(p, w, h, "vertical", len));
      const fibres = strokes(g, w, h, "vertical", len, 79);
      const b = ((filter.brightness ?? 60) - 50) / 100;
      const c = (filter.contrast ?? 80) / 80;
      return out(rgb.map((_, ch) => L.map((__, i) => ((across[ch]![i]! + down[ch]![i]!) / 2 - 0.5) * c + 0.5 + b + (fibres[i]! - 0.5) * 0.1)));
    }
    // ── Texture ──────────────────────────────────────────────────────────────────────────
    case "craquelure": {
      // Cracked plaster or old varnish: a net of grooves, each piece slightly domed.
      const size = (filter.spacing ?? 15) * 1.5 * k;
      const { f1, edge } = voronoi(g, w, h, size, 83);
      const crack = edge.map((d) => 1 - smoothstep(0, Math.max(1, 1.2 * k), d));
      const height = crack.map((c, i) => 1 - c - (f1[i]! / size) * 0.3);
      const shade = relief(height, w, h, "top-left", ((filter.depth ?? 6) / 10) * 6 * k);
      const bright = 0.8 + ((filter.brightness ?? 9) / 10) * 0.25;
      return out(rgb.map((p) => p.map((v, i) => v * bright * (1 + shade[i]! * 1.5) * (1 - crack[i]! * 0.3))));
    }
    case "grain": {
      const type = filter.type ?? "regular";
      const amount = (filter.intensity ?? 40) / 100;
      const contrast = 1 + ((filter.contrast ?? 50) - 50) / 50;
      const seeds = noise(g, w, h, 89);
      let n: Float32Array = seeds;
      if (type === "soft") n = blurPlane(seeds, w, h, 0.8 * k);
      else if (type === "clumped") n = blurPlane(seeds, w, h, 1.2 * k).map((v) => smoothstep(0.42, 0.58, v));
      else if (type === "enlarged") n = noise(g, w, h, 89, 2.5 * k);
      else if (type === "horizontal" || type === "vertical") n = strokes(g, w, h, type, 6 * k, 97);
      const toned = rgb.map((p) => p.map((v) => (v - 0.5) * contrast + 0.5));
      if (type === "stippled") return out(toned.map(() => L.map((l, i) => (seeds[i]! < (l - 0.5) * contrast + 0.5 ? 1 : 0))));
      if (type === "sprinkles" || type === "speckle")
        return out(
          toned.map((p, c) =>
            p.map((v, i) => {
              const s = seeds[i]!;
              if (type === "sprinkles") return s > 1 - amount * 0.25 ? v + (1 - v) * 0.8 : s < amount * 0.15 ? v * 0.3 : v;
              return s < amount * 0.3 ? v * (0.3 + hash(i, c, 101) * 0.4) : v;
            }),
          ),
        );
      const gain = type === "contrasty" ? 1.6 : 1;
      return out(toned.map((p) => p.map((v, i) => v + (n[i]! - 0.5) * amount * gain)));
    }
    case "mosaic-tiles": {
      // Small square tiles with grout between; each tile keeps the image, slightly bevelled.
      const size = (filter.size ?? 12) * 1.2 * k;
      const grout = Math.max(1, (filter.grout ?? 3) * 0.5 * k);
      const lighten = (filter.lighten ?? 9) / 10;
      const inTile = new Float32Array(w * h);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const [gx, gy] = [x + 0.5 + g.ox, y + 0.5 + g.oy];
          const [cx, cy] = [Math.floor(gx / size), Math.floor(gy / size)];
          // A little irregularity per tile, like hand-set tiles.
          const [jx, jy] = [(hash(cx, cy, 103) - 0.5) * grout, (hash(cx, cy, 107) - 0.5) * grout];
          const [lx, ly] = [gx - cx * size + jx, gy - cy * size + jy];
          const d = Math.min(lx, ly, size - lx, size - ly);
          inTile[y * w + x] = smoothstep(grout * 0.5, grout * 0.5 + Math.max(1, k), d);
        }
      const shade = relief(blurPlane(inTile, w, h, 0.8 * k), w, h, "top-left", 4 * k);
      return out(rgb.map((p) => p.map((v, i) => ((v * (1 + shade[i]! * 1.5)) * inTile[i]! + (v * 0.45 + lighten * 0.5) * (1 - inTile[i]!)))));
    }
    case "patchwork": {
      // Squares filled with their area's main colour, each raised to its own depth.
      const size = ((filter.size ?? 4) + 1) * 2.2 * k;
      const avg = rgb.map((p) => boxPlane(p, w, h, size / 2));
      const height = new Float32Array(w * h);
      const fill: Planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const [gx, gy] = [x + 0.5 + g.ox, y + 0.5 + g.oy];
          const [cx, cy] = [Math.floor(gx / size), Math.floor(gy / size)];
          // Each square takes the colour at its own centre.
          const [sx, sy] = [clamp((cx + 0.5) * size - g.ox, 0, w - 1), clamp((cy + 0.5) * size - g.oy, 0, h - 1)];
          for (let c = 0; c < 3; c++) fill[c]![y * w + x] = samplePlane(avg[c]!, w, h, sx, sy);
          const d = Math.min(gx - cx * size, gy - cy * size, (cx + 1) * size - gx, (cy + 1) * size - gy);
          height[y * w + x] = hash(cx, cy, 109) * smoothstep(0, Math.max(1, 0.8 * k), d);
        }
      const shade = relief(height, w, h, "top-left", ((filter.relief ?? 8) / 25) * 8 * k);
      return out(fill.map((p) => p.map((v, i) => v * (1 + shade[i]! * 1.5))));
    }
    case "stained-glass": {
      // Cells of single colour leaded together, each lit from its centre.
      const size = (filter.size ?? 10) * 1.5 * k;
      const { f1, edge, site } = voronoi(g, w, h, size, 113);
      const lead = hex(filter.color ?? "#000000");
      const border = (filter.border ?? 4) * 0.35 * k;
      const light = (filter.intensity ?? 3) / 10;
      return out(
        rgb.map((p, c) =>
          p.map((_, i) => {
            const s = site[i]!;
            const glass = samplePlane(p, w, h, (s % w) + 0.5, Math.floor(s / w) + 0.5) * (1 + light * 0.6 * (1 - Math.min(1, f1[i]! / size)));
            const t = smoothstep(border * 0.5, border * 0.5 + Math.max(1, k), edge[i]!);
            return lead[c]! + (glass - lead[c]!) * t;
          }),
        ),
      );
    }
    case "texturizer":
      return out(textured(g, rgb, w, h, { ...filter, texture: filter.texture ?? "canvas" }, 4));
  }
}

// ── Strokes ──────────────────────────────────────────────────────────────────────────────

const STEP: Record<Dir, [number, number]> = { horizontal: [1, 0], vertical: [0, 1], "right-diagonal": [1, -1], "left-diagonal": [1, 1] };

/** Averages a plane along straight lines in one direction, `half` steps either side, in O(1) per pixel. */
export function lineBlur(p: Float32Array, w: number, h: number, dir: Dir, half: number): Float32Array {
  const R = Math.max(1, Math.round(half));
  const [dx, dy] = STEP[dir];
  const out = new Float32Array(w * h);
  const idx = new Int32Array(w + h);
  const pre = new Float64Array(w + h + 2 * R + 2);
  const n = 2 * R + 1;
  for (let sy = 0; sy < h; sy++)
    for (let sx = 0; sx < w; sx++) {
      // Each line starts where the step before it would leave the image.
      const [px, py] = [sx - dx, sy - dy];
      if (px >= 0 && px < w && py >= 0 && py < h) continue;
      let m = 0;
      for (let x = sx, y = sy; x >= 0 && x < w && y >= 0 && y < h; x += dx, y += dy) idx[m++] = y * w + x;
      pre[0] = 0;
      for (let i = 0; i < m + 2 * R; i++) pre[i + 1] = pre[i]! + p[idx[clamp(i - R, 0, m - 1)]!]!;
      for (let i = 0; i < m; i++) out[idx[i]!] = (pre[i + n]! - pre[i]!) / n;
    }
  return out;
}

/** Stroke texture: noise smeared `half` px along a direction, its contrast restored, in 0..1 around 0.5. */
function strokes(g: GalleryCtx, w: number, h: number, dir: Dir, half: number, seed: number, cell = g.k): Float32Array {
  const smeared = lineBlur(noise(g, w, h, seed, cell), w, h, dir, half);
  const gain = Math.sqrt(2 * Math.max(1, Math.round(half)) + 1) * 0.9;
  return smeared.map((v) => clamp((v - 0.5) * gain + 0.5, 0, 1));
}

/** Moves each pixel by a random amount up to `radius`, the offsets smoothed by `smooth` px. */
function scatter(g: GalleryCtx, src: Float32Array[], w: number, h: number, radius: number, smooth: number): Float32Array[] {
  const dx = blurPlane(noise(g, w, h, 127), w, h, smooth);
  const dy = blurPlane(noise(g, w, h, 131), w, h, smooth);
  // Blurring shrinks the offsets; stretch them back to the full radius.
  const gain = radius * 2 * (smooth > 0.5 ? Math.min(4, 1 + smooth * 0.6) : 1);
  return src.map((p) => {
    const o = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        o[i] = samplePlane(p, w, h, x + 0.5 + clamp((dx[i]! - 0.5) * gain, -radius, radius), y + 0.5 + clamp((dy[i]! - 0.5) * gain, -radius, radius));
      }
    return o;
  });
}

// ── Surfaces and relief ──────────────────────────────────────────────────────────────────

const LIGHT_ANGLE: Record<Light, number> = { right: 0, "top-right": 45, top: 90, "top-left": 135, left: 180, "bottom-left": 225, bottom: 270, "bottom-right": 315 };

/** A unit vector towards a light 45° above the surface, from the given side (y points down). */
function lightVector(light: Light): [number, number, number] {
  const a = (LIGHT_ANGLE[light] * Math.PI) / 180;
  return [Math.cos(a) * Math.SQRT1_2, -Math.sin(a) * Math.SQRT1_2, Math.SQRT1_2];
}

/** How much lighter (+) or darker (−) each pixel of a height map looks than flat ground, lit from `light`. */
function relief(height: Float32Array, w: number, h: number, light: Light, depth: number): Float32Array {
  const [lx, ly, lz] = lightVector(light);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = (height[y * w + Math.min(w - 1, x + 1)]! - height[y * w + Math.max(0, x - 1)]!) * 0.5 * depth;
      const gy = (height[Math.min(h - 1, y + 1) * w + x]! - height[Math.max(0, y - 1) * w + x]!) * 0.5 * depth;
      const [nx, ny, nz] = normalize(-gx, -gy, 1);
      out[y * w + x] = nx * lx + ny * ly + nz * lz - lz;
    }
  return out;
}

type SurfaceFields = { texture?: "canvas" | "burlap" | "brick" | "sandstone"; scaling?: number; relief?: number; light?: Light; invert?: boolean };

/** Lights colour planes as if printed on a surface texture. */
function textured(g: GalleryCtx, base: Float32Array[], w: number, h: number, fields: SurfaceFields, defaultRelief: number): Float32Array[] {
  const height = surface(g, w, h, fields.texture ?? "canvas", (fields.scaling ?? 100) / 100, fields.invert ?? false);
  const shade = relief(height, w, h, fields.light ?? "top", ((fields.relief ?? defaultRelief) / 50) * 4 * g.k);
  return base.map((p) => p.map((v, i) => v * (1 + shade[i]! * 1.2)));
}

/** A surface's height map in 0..1, anchored to the artboard and `scale` times its usual size. */
function surface(g: GalleryCtx, w: number, h: number, kind: NonNullable<SurfaceFields["texture"]>, scale: number, invert: boolean): Float32Array {
  const out = new Float32Array(w * h);
  const unit = g.k * scale;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [gx, gy] = [(x + 0.5 + g.ox) / unit, (y + 0.5 + g.oy) / unit];
      let v: number;
      if (kind === "canvas" || kind === "burlap") {
        // A plain weave: threads alternate over and under; burlap is coarser, looser and uneven.
        const p = kind === "canvas" ? 4 : 8;
        const [tx, ty] = [gx / p, gy / p];
        const across = Math.sin(Math.PI * (ty - Math.floor(ty))) ** (kind === "burlap" ? 1.5 : 1);
        const along = Math.sin(Math.PI * (tx - Math.floor(tx))) ** (kind === "burlap" ? 1.5 : 1);
        const over = (Math.floor(tx) + Math.floor(ty)) & 1;
        v = over ? Math.max(across * 0.95, along * 0.55) : Math.max(along * 0.95, across * 0.55);
        if (kind === "burlap") v *= 0.7 + 0.3 * fbm(gx / 9, gy / 9, 2, 137);
      } else if (kind === "brick") {
        // Running bond: each course shifts by half a brick; mortar sits lower.
        const [bw, bh] = [22, 10];
        const row = Math.floor(gy / bh);
        const bx = gx + (row & 1 ? bw / 2 : 0);
        const [lx, ly] = [bx - Math.floor(bx / bw) * bw, gy - row * bh];
        const d = Math.min(lx, ly, bw - lx, bh - ly);
        v = smoothstep(0.6, 1.8, d) * (0.85 + 0.15 * hash(Math.floor(bx / bw), row, 139)) + (hash(Math.floor(gx), Math.floor(gy), 149) - 0.5) * 0.08;
      } else {
        // Sandstone: fine grains over a gently rolling surface.
        v = fbm(gx / 14, gy / 14, 3, 151) * 0.6 + hash(Math.floor(gx), Math.floor(gy), 157) * 0.4;
      }
      out[y * w + x] = invert ? 1 - v : v;
    }
  return out;
}

// ── Cells ────────────────────────────────────────────────────────────────────────────────

/** Jittered-grid Voronoi: distance to the nearest site, to the nearest cell edge, and the nearest site's pixel. */
function voronoi(g: GalleryCtx, w: number, h: number, size: number, seed: number): { f1: Float32Array; edge: Float32Array; site: Int32Array } {
  const f1 = new Float32Array(w * h);
  const edge = new Float32Array(w * h);
  const site = new Int32Array(w * h);
  // One jittered site per grid cell, worked out once for the cells this image touches (plus a ring around them).
  const [c0, r0] = [Math.floor(g.ox / size) - 2, Math.floor(g.oy / size) - 2];
  const [cols, rows] = [Math.ceil((g.ox + w) / size) + 2 - c0 + 1, Math.ceil((g.oy + h) / size) + 2 - r0 + 1];
  const sx = new Float64Array(cols * rows);
  const sy = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      sx[j * cols + i] = (c0 + i + 0.1 + hash(c0 + i, r0 + j, seed) * 0.8) * size;
      sy[j * cols + i] = (r0 + j + 0.1 + hash(c0 + i, r0 + j, seed + 1) * 0.8) * size;
    }
  const near = new Int32Array(9);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [gx, gy] = [x + 0.5 + g.ox, y + 0.5 + g.oy];
      const [cx, cy] = [Math.floor(gx / size) - c0, Math.floor(gy / size) - r0];
      let [b1, best, m] = [Infinity, 0, 0];
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const n = (cy + j) * cols + cx + i;
          near[m++] = n;
          const d = (sx[n]! - gx) ** 2 + (sy[n]! - gy) ** 2;
          if (d < b1) [b1, best] = [d, n];
        }
      // Distance to the edge with each other site: along the line between the two sites.
      const [bx, by] = [sx[best]!, sy[best]!];
      let e = Infinity;
      for (let q = 0; q < 9; q++) {
        const n = near[q]!;
        if (n === best) continue;
        const [nx, ny] = [sx[n]! - bx, sy[n]! - by];
        const l = Math.sqrt(nx * nx + ny * ny) || 1;
        e = Math.min(e, (((sx[n]! + bx) / 2 - gx) * nx + ((sy[n]! + by) / 2 - gy) * ny) / l);
      }
      const i = y * w + x;
      f1[i] = Math.sqrt(b1);
      edge[i] = e;
      site[i] = clamp(Math.round(by - g.oy - 0.5), 0, h - 1) * w + clamp(Math.round(bx - g.ox - 0.5), 0, w - 1);
    }
  return { f1, edge, site };
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────

/** Noise in 0..1 anchored to the artboard: one value per `cell` output px (an artboard unit by default). */
function noise(g: GalleryCtx, w: number, h: number, seed: number, cell = g.k): Float32Array {
  const c = Math.max(1, cell);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = hash(Math.floor((x + g.ox) / c), Math.floor((y + g.oy) / c), seed);
  return out;
}

function fbmPlane(g: GalleryCtx, w: number, h: number, scale: number, seed: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = fbm((x + g.ox) / scale, (y + g.oy) / scale, 4, seed);
  return out;
}

/** A Gaussian-like blur of one plane (three box passes). */
function blurPlane(p: Float32Array, w: number, h: number, sigma: number): Float32Array {
  if (sigma < 0.3) return p.slice();
  const rr = Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5;
  return boxPlane(boxPlane(boxPlane(p, w, h, rr), w, h, rr), w, h, rr);
}

/** Edge strength (Sobel at `step` px) of a plane, in 0..1. */
function sobel(p: Float32Array, w: number, h: number, step: number): Float32Array {
  const s = Math.max(1, Math.round(step));
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const [up, mid, down] = [Math.max(0, y - s) * w, y * w, Math.min(h - 1, y + s) * w];
    for (let x = 0; x < w; x++) {
      const [l, r] = [Math.max(0, x - s), Math.min(w - 1, x + s)];
      const gx = p[up + r]! + 2 * p[mid + r]! + p[down + r]! - p[up + l]! - 2 * p[mid + l]! - p[down + l]!;
      const gy = p[down + l]! + 2 * p[down + x]! + p[down + r]! - p[up + l]! - 2 * p[up + x]! - p[up + r]!;
      out[mid + x] = Math.min(1, Math.sqrt(gx * gx + gy * gy) * 0.5);
    }
  }
  return out;
}

const hex = (c: string): Rgb => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as Rgb;
const inks = (colors: [string, string] | undefined): [Rgb, Rgb] => [hex(colors?.[0] ?? "#000000"), hex(colors?.[1] ?? "#FFFFFF")];
/** Colour planes between the foreground (t = 0) and background (t = 1) inks. */
const twoTone = (fg: Rgb, bg: Rgb, t: Float32Array): Planes => [0, 1, 2].map((c) => t.map((v) => fg[c]! + (bg[c]! - fg[c]!) * v)) as Planes;

function normalize(x: number, y: number, z: number): [number, number, number] {
  const l = Math.sqrt(x * x + y * y + z * z) || 1;
  return [x / l, y / l, z / l];
}
