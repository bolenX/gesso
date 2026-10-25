import sharp from "sharp";

// Synthetic photos for the skills' examples. They're drawn from code, so every machine gets the same
// pixels and nothing needs a licence. Each has the features its workflows act on, at known places:
// pores and blemishes on a portrait, dust on a product shot, a blown window in an interior, scratches
// and a stain on an old print. The regions here are what the examples' checks measure.

export const W = 480;
export const H = 360;

type RGB = [number, number, number];

/** Deterministic hash noise in 0..1. */
const hash = (x: number, y: number, seed = 0) => {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Smooth value noise, roughly −1..1, at a feature size of `scale` pixels. */
function valueNoise(x: number, y: number, scale: number, seed: number): number {
  const [gx, gy] = [x / scale, y / scale];
  const [x0, y0] = [Math.floor(gx), Math.floor(gy)];
  const [fx, fy] = [gx - x0, gy - y0];
  const s = (t: number) => t * t * (3 - 2 * t);
  const v = (i: number, j: number) => hash(x0 + i, y0 + j, seed) * 2 - 1;
  const top = v(0, 0) + (v(1, 0) - v(0, 0)) * s(fx);
  const bottom = v(0, 1) + (v(1, 1) - v(0, 1)) * s(fx);
  return top + (bottom - top) * s(fy);
}

/** Gaussian-ish noise from four uniform draws, σ about 1. */
const grain = (x: number, y: number, seed: number) => (hash(x, y, seed) + hash(x, y, seed + 1) + hash(x, y, seed + 2) + hash(x, y, seed + 3) - 2) * 1.73;

class Canvas {
  readonly d = new Float32Array(W * H * 3);

  paint(at: (x: number, y: number, current: RGB) => RGB | undefined) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 3;
        const out = at(x, y, [this.d[i]!, this.d[i + 1]!, this.d[i + 2]!]);
        if (out) [this.d[i], this.d[i + 1], this.d[i + 2]] = out;
      }
    }
  }

  /** Anti-aliased ellipse: `color` gives the colour at a point and its normalised radius (0 centre, 1 edge). */
  ellipse(cx: number, cy: number, rx: number, ry: number, color: (x: number, y: number, r: number) => RGB) {
    this.paint((x, y, cur) => {
      const r = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      const cover = Math.min(1, Math.max(0, (1 - r) * Math.min(rx, ry) + 0.5));
      if (cover <= 0) return undefined;
      const c = color(x, y, r);
      return [cur[0] + (c[0] - cur[0]) * cover, cur[1] + (c[1] - cur[1]) * cover, cur[2] + (c[2] - cur[2]) * cover];
    });
  }

  rect(x0: number, y0: number, w: number, h: number, color: (x: number, y: number) => RGB) {
    this.paint((x, y) => (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h ? color(x, y) : undefined));
  }

  png(): Promise<Buffer> {
    const bytes = Buffer.alloc(W * H * 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round(this.d[i]!)));
    return sharp(bytes, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
  }
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const add = (c: RGB, v: number): RGB => [c[0] + v, c[1] + v, c[2] + v];

/** Where the blemishes are on the portrait. */
export const BLEMISHES: Array<[number, number]> = [
  [170, 205], [182, 222], [160, 230], [300, 210], [312, 228], [292, 236], [225, 110], [255, 102], [240, 125], [205, 245], [280, 250], [190, 190], [295, 192], [248, 200],
];

async function portrait(): Promise<Buffer> {
  const c = new Canvas();
  c.paint((x, y) => mix([58, 42, 36], [30, 23, 20], y / H));
  c.ellipse(240, 120, 128, 110, (x, y) => add([42, 30, 24], grain(x, y, 9) * 4));
  c.ellipse(240, 190, 110, 140, (x, y, r) => {
    const base = mix([236, 186, 156], [176, 116, 88], Math.min(1, r * r));
    const blotch = valueNoise(x, y, 26, 3) * 14;
    const pores = grain(x, y, 5) * 7;
    return [base[0] + blotch + pores, base[1] + pores - blotch * 0.3, base[2] + pores - blotch * 0.3];
  });
  for (const [bx, by] of BLEMISHES) c.ellipse(bx, by, 3.2, 3.2, () => [150, 70, 62]);
  for (const ex of [195, 285]) {
    c.ellipse(ex, 165, 18, 9, () => [232, 226, 220]);
    c.ellipse(ex, 165, 7, 7, () => [74, 106, 138]);
    c.ellipse(ex, 165, 3, 3, () => [12, 12, 14]);
  }
  c.ellipse(240, 258, 34, 10, (x, y) => add([180, 80, 90], grain(x, y, 7) * 3));
  return c.png();
}

/** Dust specks on the product shot. */
export const SPECKS: Array<[number, number]> = Array.from({ length: 24 }, (_, i) => [20 + Math.floor(hash(i, 1, 11) * 160), 30 + Math.floor(hash(i, 2, 11) * 260)]);

async function product(): Promise<Buffer> {
  const c = new Canvas();
  c.paint((x, y) => add(mix([242, 242, 240], [214, 214, 210], y / H), grain(x, y, 2) * 1.5));
  c.rect(225, 30, 30, 40, () => [24, 62, 38]);
  c.rect(200, 60, 80, 260, (x) => {
    const stripe = Math.exp(-(((x - 216) / 5) ** 2)) * 70;
    return [31 + stripe, 74 + stripe, 46 + stripe];
  });
  c.rect(205, 170, 70, 80, () => [238, 228, 204]);
  for (let i = 0; i < 4; i++) c.rect(214, 184 + i * 14, 52 - i * 8, 5, () => [40, 34, 30]);
  for (const [sx, sy] of SPECKS) c.ellipse(sx, sy, 1.8, 1.8, () => [90, 90, 88]);
  return c.png();
}

/** An interior: walls, ceiling, floor and a window. `kind` picks the exposure. */
async function interior(kind: "ambient" | "flash" | "window"): Promise<Buffer> {
  const c = new Canvas();
  const wall: RGB = kind === "flash" ? [190, 188, 185] : [200, 178, 150];
  c.paint((x, y) => {
    const v = y < 60 ? mix(wall, [235, 232, 228], 0.4) : y > 290 ? (kind === "flash" ? [92, 70, 52] : [108, 80, 56]) : wall;
    const shade = kind === "flash" ? (y > 250 && y < 290 ? -40 * ((y - 250) / 40) : 0) : -12 * Math.abs(x - 240) / 240;
    return add(v as RGB, shade + grain(x, y, 4) * 2);
  });
  c.rect(300, 80, 120, 140, (x, y) => {
    if (kind === "ambient") return [255, 255, 255];
    const sky = mix([156, 195, 230], [220, 232, 242], (y - 80) / 140);
    const trees = y > 170 + 12 * Math.sin(x / 9) ? [44, 86, 40] : sky;
    return kind === "window" ? (trees as RGB) : mix(trees as RGB, [255, 255, 255], 0.55);
  });
  for (const t of [0.25, 0.5, 0.75]) c.rect(300 + 120 * t - 1, 80, 3, 140, () => [70, 64, 60]);
  if (kind === "window") c.paint((x, y, cur) => (x >= 300 && x < 420 && y >= 80 && y < 220 ? undefined : [cur[0] * 0.35, cur[1] * 0.35, cur[2] * 0.35]));
  return c.png();
}

async function exterior(): Promise<Buffer> {
  const c = new Canvas();
  c.paint((x, y) => (y < 150 ? add([184, 188, 192], grain(x, y, 6)) : [0, 0, 0]));
  c.rect(0, 150, W, 100, () => [70, 76, 64]);
  c.rect(130, 110, 220, 140, (x, y) => add([216, 207, 192], grain(x, y, 8) * 2));
  c.paint((x, y) => (y >= 60 && y < 112 && Math.abs(x - 240) < 20 + (y - 60) * 2.9 ? [72, 52, 46] : undefined));
  c.rect(220, 190, 40, 60, () => [90, 60, 44]);
  c.rect(0, 250, W, 110, (x, y) => {
    const patch = valueNoise(x, y, 22, 7) > 0.35;
    return add(patch ? [138, 122, 74] : [94, 138, 58], grain(x, y, 3) * 6);
  });
  return c.png();
}

/** Scratches and specks on the old print. */
export const SCRATCHES: Array<[number, number, number, number]> = [[60, 0, 70, 359], [150, 20, 140, 300], [380, 10, 395, 340], [250, 200, 470, 230]];

async function oldPhoto(): Promise<Buffer> {
  const c = new Canvas();
  c.paint((x, y) => {
    const scene = y < 170 ? 0.75 - y / 900 : 0.35 + 0.15 * Math.sin(x / 40);
    const v = 60 + 130 * scene;
    return add([v * 1.08, v, v * 0.84], grain(x, y, 12) * 6);
  });
  c.ellipse(170, 230, 60, 90, (x, y) => add([96, 88, 74], grain(x, y, 13) * 6));
  for (const [x0, y0, x1, y1] of SCRATCHES) {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let s = 0; s <= steps; s++) {
      const [x, y] = [Math.round(x0 + ((x1 - x0) * s) / steps), Math.round(y0 + ((y1 - y0) * s) / steps)];
      if (x >= 0 && x < W && y >= 0 && y < H) c.d.set([228, 222, 208], (y * W + x) * 3);
    }
  }
  for (let i = 0; i < 30; i++) c.ellipse(10 + hash(i, 3, 14) * 460, 10 + hash(i, 4, 14) * 340, 1.6, 1.6, () => (i % 2 ? [236, 230, 216] : [30, 26, 22]));
  c.paint((x, y, cur) => {
    const d = Math.hypot((x - 365) / 45, (y - 95) / 35) + valueNoise(x, y, 9, 2) * 0.2;
    if (d >= 1) return undefined;
    const t = (1 - d) * 0.55;
    return [cur[0] * (1 - t * 0.1), cur[1] * (1 - t * 0.35), cur[2] * (1 - t * 0.7)];
  });
  return c.png();
}

async function landscape(): Promise<Buffer> {
  const c = new Canvas();
  c.paint((x, y) => {
    if (y < 200) return mix([70, 120, 190], [214, 228, 240], y / 200);
    return add(mix([62, 96, 46], [34, 56, 30], (y - 200) / 160), grain(x, y, 21) * 5);
  });
  c.paint((x, y) => (y > 130 + 28 * Math.sin(x / 50) + 12 * Math.sin(x / 13) && y < 210 ? [104, 122, 146] : undefined));
  c.paint((x, y) => (y > 180 + 20 * Math.sin(x / 70 + 1) && y < 240 ? add([70, 102, 52], grain(x, y, 22) * 4) : undefined));
  c.ellipse(380, 70, 22, 22, () => [255, 244, 214]);
  return c.png();
}

export const FIXTURES: Record<string, () => Promise<Buffer>> = {
  portrait,
  product,
  "interior-ambient": () => interior("ambient"),
  "interior-flash": () => interior("flash"),
  "interior-window": () => interior("window"),
  exterior,
  "old-photo": oldPhoto,
  landscape,
};
