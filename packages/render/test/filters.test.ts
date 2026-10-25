import { Filter as FilterSchema, type Doc, type Filter, type Layer } from "@gesso/core";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { median } from "../src/cpu.js";
import { renderArtboard, type AssetLoader } from "../src/index.js";
import { SAMPLES } from "./filter-samples.js";


const SIZE = 100;
const files: Record<string, Uint8Array> = {};
const loader: AssetLoader = async ({ uri }) => files[uri]!;

/** A busy test photo: a hue sweep, a light-to-dark ramp, bars, a disc, mild noise and a few specks. */
async function testPhoto(size = SIZE): Promise<Uint8Array> {
  const raw = Buffer.alloc(size * size * 3);
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const [u, v] = [x / size, y / size];
      const hue = u * 6;
      const rgb = [Math.abs(hue - 3) - 1, 2 - Math.abs(hue - 2), 2 - Math.abs(hue - 4)].map((c) => Math.min(1, Math.max(0, c)));
      const light = 0.25 + 0.6 * (1 - v);
      let px = rgb.map((c) => (c * 0.7 + 0.3) * light * 255);
      if (Math.floor(u * 8) % 3 === 0) px = px.map((c) => c * 0.6);
      if ((u - 0.6) ** 2 + (v - 0.45) ** 2 < 0.03) px = [235, 225, 210];
      px = px.map((c) => c + (rand() - 0.5) * 24);
      if (rand() < 0.004) px = [255, 255, 255];
      raw.set(px.map((c) => Math.round(Math.min(255, Math.max(0, c)))), (y * size + x) * 3);
    }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer();
}

async function gradientPng(horizontal: boolean): Promise<Uint8Array> {
  const raw = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) raw.set(horizontal ? [x * 4, y * 4, 128] : [y * 4, y * 4, y * 4], (y * 64 + x) * 3);
  return sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
}

const photoDoc = (filters: Filter[]): Doc => ({
  id: "t",
  revision: 0,
  assets: { photo: { uri: "photo.png", kind: "image" }, map: { uri: "map.png", kind: "image" }, depth: { uri: "depth.png", kind: "image" } },
  artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: SIZE, h: SIZE }, layers: [{ id: "pic", name: "pic", type: "image", asset: "photo", frame: { x: 0, y: 0, w: SIZE, h: SIZE }, filters } as Layer] }],
});

const px = (pixels: Uint8Array, x: number, y: number, width = SIZE) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (i % 4 !== 3) d += Math.abs(a[i]! - b[i]!);
  return d / ((a.length / 4) * 3);
};

beforeAll(async () => {
  files["photo.png"] = await testPhoto();
  files["map.png"] = await gradientPng(true);
  files["depth.png"] = await gradientPng(false);
});

describe("Filter menu", () => {
  it("has a sample of every filter kind, each valid", () => {
    const kinds = FilterSchema.options.map((o) => o.shape.kind.value);
    expect(SAMPLES.map((s) => s.kind).sort()).toEqual([...kinds].sort());
    for (const s of SAMPLES) expect(FilterSchema.safeParse(s).success, s.kind).toBe(true);
  });

  it("runs every filter deterministically, changing the image and keeping it opaque", async () => {
    const plain = await renderArtboard(photoDoc([]), "a", { loader });
    const slow: string[] = [];
    for (const filter of SAMPLES) {
      const start = performance.now();
      const a = await renderArtboard(photoDoc([filter]), "a", { loader });
      if (performance.now() - start > 1500) slow.push(filter.kind);
      const b = await renderArtboard(photoDoc([filter]), "a", { loader });
      expect(a.warnings, filter.kind).toEqual([]);
      expect(Buffer.from(a.pixels).equals(Buffer.from(b.pixels)), `${filter.kind} is deterministic`).toBe(true);
      expect(meanDiff(a.pixels, plain.pixels), `${filter.kind} changes the image`).toBeGreaterThan(0.2);
      for (const [x, y] of [[0, 0], [50, 50], [99, 99]] as const) expect(px(a.pixels, x, y)[3], `${filter.kind} keeps the layer opaque`).toBe(255);
    }
    expect(slow).toEqual([]);
  }, 60_000);

  it("fades a filter by opacity and blend mode (Edit › Fade)", async () => {
    const plain = await renderArtboard(photoDoc([]), "a", { loader });
    const full = await renderArtboard(photoDoc([{ kind: "find-edges" }]), "a", { loader });
    const half = await renderArtboard(photoDoc([{ kind: "find-edges", opacity: 0.5 }]), "a", { loader });
    const [p, f, h] = [px(plain.pixels, 30, 70), px(full.pixels, 30, 70), px(half.pixels, 30, 70)];
    for (let c = 0; c < 3; c++) expect(Math.abs(h[c]! - (p[c]! + f[c]!) / 2)).toBeLessThanOrEqual(2);
    const multiplied = await renderArtboard(photoDoc([{ kind: "find-edges", blend: "multiply" }]), "a", { loader });
    const m = px(multiplied.pixels, 30, 70);
    for (let c = 0; c < 3; c++) expect(Math.abs(m[c]! - Math.round((p[c]! * f[c]!) / 255))).toBeLessThanOrEqual(2);
  });

  it("removes a speck with a median and dust & scratches, keeping flat areas", async () => {
    const w = 9;
    const flat = new Uint8Array(w * w * 4).fill(100);
    flat.set([255, 255, 255, 255], (4 * w + 4) * 4);
    const out = median(flat, w, w, 1);
    expect(Array.from(out.slice((4 * w + 4) * 4, (4 * w + 4) * 4 + 3))).toEqual([100, 100, 100]);
    expect(out[0]).toBe(100);
  });

  it("grows and shrinks light areas with Maximum and Minimum", async () => {
    const doc = (kind: "maximum" | "minimum"): Doc => ({
      id: "m",
      revision: 0,
      assets: {},
      artboards: [
        {
          id: "a",
          name: "A",
          frame: { x: 0, y: 0, w: 40, h: 40 },
          layers: [
            {
              id: "g",
              name: "g",
              type: "group",
              isolation: "isolate",
              frame: { x: 0, y: 0, w: 40, h: 40 },
              filters: [{ kind, radius: 3 }],
              children: [
                { id: "bg", name: "bg", type: "shape", shape: { kind: "rect" }, fill: "#000000", frame: { x: 0, y: 0, w: 40, h: 40 } },
                { id: "dot", name: "dot", type: "shape", shape: { kind: "rect" }, fill: "#FFFFFF", frame: { x: 15, y: 15, w: 10, h: 10 } },
              ],
            } as Layer,
          ],
        },
      ],
    });
    const grown = await renderArtboard(doc("maximum"), "a");
    expect(px(grown.pixels, 13, 20, 40)[0]).toBe(255);
    const shrunk = await renderArtboard(doc("minimum"), "a");
    expect(px(shrunk.pixels, 16, 20, 40)[0]).toBe(0);
    expect(px(shrunk.pixels, 20, 20, 40)[0]).toBe(255);
  });

  it("wraps pixels around with Offset", async () => {
    const plain = await renderArtboard(photoDoc([]), "a", { loader });
    const out = await renderArtboard(photoDoc([{ kind: "offset", x: 30, y: 0 }]), "a", { loader });
    expect(px(out.pixels, 40, 50)).toEqual(px(plain.pixels, 10, 50));
    expect(px(out.pixels, 10, 50)).toEqual(px(plain.pixels, 80, 50));
  });

  it("solarizes: dark tones stay, bright tones invert", async () => {
    const doc = (fill: string): Doc => ({
      id: "s",
      revision: 0,
      assets: {},
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 10, h: 10 }, layers: [{ id: "r", name: "r", type: "shape", shape: { kind: "rect" }, fill, frame: { x: 0, y: 0, w: 10, h: 10 }, filters: [{ kind: "solarize" }] } as Layer] }],
    });
    expect(px((await renderArtboard(doc("#303030"), "a")).pixels, 5, 5, 10).slice(0, 3)).toEqual([48, 48, 48]);
    expect(px((await renderArtboard(doc("#E0E0E0"), "a")).pixels, 5, 5, 10).slice(0, 3)).toEqual([31, 31, 31]);
  });

  it("keeps the subject sharp where a lens blur's depth map is in focus", async () => {
    // The depth map runs dark (near, in focus at 0) at the top to light (far) at the bottom.
    const plain = await renderArtboard(photoDoc([]), "a", { loader });
    const out = await renderArtboard(photoDoc([{ kind: "lens-blur", radius: 8, depth: "depth", focus: 0 }]), "a", { loader });
    const rowDiff = (y: number) => {
      let d = 0;
      for (let x = 0; x < SIZE; x++) for (let c = 0; c < 3; c++) d += Math.abs(px(out.pixels, x, y)[c]! - px(plain.pixels, x, y)[c]!);
      return d / SIZE;
    };
    expect(rowDiff(2)).toBeLessThan(rowDiff(95) / 3);
  });
});

describe("filtered layer cache", () => {
  it("reuses a filtered layer when only other layers change, and re-filters when its filter does", async () => {
    const { filterCacheStats } = await import("../src/index.js");
    const photo = await sharp({ create: { width: 120, height: 80, channels: 3, background: "#3080C0" } }).composite([{ input: Buffer.from('<svg width="120" height="80"><circle cx="60" cy="40" r="25" fill="#FFC21A"/></svg>'), left: 0, top: 0 }]).png().toBuffer();
    const loader = async () => photo;
    const doc = (radius: number, tint: string): Doc => ({
      id: "cache",
      revision: 0,
      assets: { photo: { uri: "photo", kind: "image" } },
      artboards: [
        {
          id: "a",
          name: "A",
          frame: { x: 0, y: 0, w: 120, h: 80 },
          layers: [
            { id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: 120, h: 80 }, filters: [{ kind: "surface-blur", radius, threshold: 20 }] } as Layer,
            { id: "t", name: "t", type: "shape", shape: { kind: "rect" }, fill: tint, frame: { x: 10, y: 10, w: 20, h: 20 } } as Layer,
          ],
        },
      ],
    });
    const first = await renderArtboard(doc(5, "#FF0000"), "a", { loader });
    const hits = filterCacheStats.hits;
    const second = await renderArtboard(doc(5, "#00FF00"), "a", { loader });
    expect(filterCacheStats.hits).toBe(hits + 1);
    // The filtered photo is the same pixels; only the small square changed colour.
    expect(Buffer.from(second.pixels.subarray((60 * 120 + 100) * 4, (60 * 120 + 100) * 4 + 4))).toEqual(Buffer.from(first.pixels.subarray((60 * 120 + 100) * 4, (60 * 120 + 100) * 4 + 4)));
    const misses = filterCacheStats.misses;
    await renderArtboard(doc(8, "#00FF00"), "a", { loader });
    expect(filterCacheStats.misses).toBe(misses + 1);
  });
});
