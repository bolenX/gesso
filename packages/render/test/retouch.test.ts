import type { Doc, Filter, Layer } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderArtboard, type AssetLoader } from "../src/index.js";

const W = 80;
const px = (p: Uint8Array, x: number, y: number, w = W) => Array.from(p.slice((y * w + x) * 4, (y * w + x) * 4 + 3));

/** Vertical stripes (8 px, grey and dark) with a red disc in the middle, as an image asset. */
async function stripes(): Promise<Uint8Array> {
  const raw = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const v = Math.floor(x / 8) % 2 ? 200 : 60;
      const red = (x - 40) ** 2 + (y - 40) ** 2 < 36;
      raw.set(red ? [230, 20, 20] : [v, v, v], (y * W + x) * 3);
    }
  return sharp(raw, { raw: { width: W, height: W, channels: 3 } }).png().toBuffer();
}

describe("retouching", async () => {
  const png = await stripes();
  const loader: AssetLoader = async () => png;
  const doc = (filters: Filter[], extra: object = {}): Doc => ({
    id: "r",
    revision: 0,
    assets: { photo: { uri: "photo.png", kind: "image" } },
    artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: W, h: W }, layers: [{ id: "p", name: "p", type: "image", asset: "photo", frame: { x: 0, y: 0, w: W, h: W }, filters, ...extra } as Layer] }],
  });
  const spot = { at: [0.5, 0.5] as [number, number], size: [0.2, 0.2] as [number, number] };

  it("removes an object with Content-Aware Fill, continuing the texture", async () => {
    const out = (await renderArtboard(doc([{ kind: "content-aware-fill", spots: [spot] }]), "a", { loader })).pixels;
    // No red left, and the stripes carry on through where the disc was.
    for (const [x, y] of [[40, 40], [37, 42], [43, 38]] as const) {
      const [r, g, b] = px(out, x, y);
      expect(Math.abs(r! - g!), `pixel ${x},${y}: ${[r, g, b]}`).toBeLessThan(40);
      expect(Math.abs(g! - b!)).toBeLessThan(40);
    }
    const dark = px(out, 36, 40)[0]!; // column 36 is in a light stripe (32..39), 41 in a dark one (40..47)
    const light = px(out, 44, 40)[0]!;
    expect(Math.abs(dark - light)).toBeGreaterThan(60);
  });

  it("copies from an offset with Clone Stamp", async () => {
    // 16 px to the left is the same stripe phase, without the disc.
    const out = (await renderArtboard(doc([{ kind: "clone", spots: [{ ...spot, feather: 0 }], offset: [-16, 0] }]), "a", { loader })).pixels;
    expect(px(out, 40, 40)).toEqual(px(out, 24, 40));
  });

  it("heals: takes the source's texture but the surroundings' light", async () => {
    // A spot over plain stripes (x 12..28, y 52..68 with its soft edge), cloned from 32 px above
    // (the same stripes), where a band lifts everything by +48 levels. Plain cloning carries the
    // lift into the spot; healing matches it to the surroundings.
    const low = { at: [0.25, 0.75] as [number, number], size: [0.2, 0.2] as [number, number] };
    const lift: Layer = { id: "b", name: "b", type: "shape", shape: { kind: "rect" }, fill: "#303030", blend: "linear-dodge", frame: { x: 0, y: 0, w: W, h: 42 } } as Layer;
    const base = (filters: Filter[]): Doc => ({ ...doc([]), artboards: [{ ...doc([]).artboards[0]!, layers: [{ id: "g", name: "g", type: "group", isolation: "isolate", frame: { x: 0, y: 0, w: W, h: W }, filters, children: [doc([]).artboards[0]!.layers[0]!, lift] } as Layer] }] });
    const cloned = (await renderArtboard(base([{ kind: "clone", spots: [low], offset: [0, -32] }]), "a", { loader })).pixels;
    const healed = (await renderArtboard(base([{ kind: "heal", spots: [low], offset: [0, -32] }]), "a", { loader })).pixels;
    // Column 12 is a light stripe (200), 20 a dark one (60).
    expect(Math.abs(px(cloned, 12, 60)[0]! - 200)).toBeGreaterThan(30);
    expect(Math.abs(px(healed, 12, 60)[0]! - 200)).toBeLessThan(10);
    expect(Math.abs(px(healed, 20, 60)[0]! - 60)).toBeLessThan(10);
  });

  it("narrows an image by removing seams, keeping its objects intact (Content-Aware Scale)", async () => {
    // Two 10 px squares on flat white: narrowing to half removes background, not squares.
    const raw = Buffer.alloc(W * 40 * 3, 255);
    for (let y = 15; y < 25; y++)
      for (const x0 of [10, 60]) for (let x = x0; x < x0 + 10; x++) raw.set([20, 40, 200], (y * W + x) * 3);
    const squares = await sharp(raw, { raw: { width: W, height: 40, channels: 3 } }).png().toBuffer();
    const fitted: Doc = {
      id: "s",
      revision: 0,
      assets: { photo: { uri: "s.png", kind: "image" } },
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 40, h: 40 }, layers: [{ id: "p", name: "p", type: "image", asset: "photo", fit: "content-aware", frame: { x: 0, y: 0, w: 40, h: 40 } } as Layer] }],
    };
    const out = (await renderArtboard(fitted, "a", { loader: async () => squares })).pixels;
    // Width in pixels of blue along the middle row: each square stays about 10 px wide (not 5).
    let blue = 0;
    for (let x = 0; x < 40; x++) if (px(out, x, 20, 40)[2]! > 150 && px(out, x, 20, 40)[0]! < 100) blue++;
    expect(blue).toBeGreaterThanOrEqual(17);
  });
});
