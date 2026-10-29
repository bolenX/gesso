import type { Doc, Filter, Layer } from "@gesso/core";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { renderArtboard, type AssetLoader } from "../src/index.js";
import { project, rectToQuad } from "../src/perspective.js";

// What the newer filters do, beyond the checks every filter gets in filters.test.ts.

const SIZE = 100;
const files: Record<string, Uint8Array> = {};
const loader: AssetLoader = async ({ uri }) => files[uri]!;

const rect = (id: string, fill: string, frame: { x: number; y: number; w: number; h: number }): Layer =>
  ({ id, name: id, type: "shape", shape: { kind: "rect" }, fill, frame }) as Layer;

/** An isolated group of shapes with the filters on it. */
const doc = (filters: Filter[], children: Layer[], assets: Doc["assets"] = {}): Doc => ({
  id: "t",
  revision: 0,
  assets,
  artboards: [
    {
      id: "a",
      name: "A",
      frame: { x: 0, y: 0, w: SIZE, h: SIZE },
      layers: [{ id: "g", name: "g", type: "group", isolation: "isolate", frame: { x: 0, y: 0, w: SIZE, h: SIZE }, filters, children } as Layer],
    },
  ],
});

/** White on the left, black on the right of x = split (a fraction). */
const halves = (split = 0.5) => [rect("white", "#FFFFFF", { x: 0, y: 0, w: SIZE, h: SIZE }), rect("black", "#000000", { x: SIZE * split, y: 0, w: SIZE * (1 - split), h: SIZE })];
const px = (pixels: Uint8Array, x: number, y: number) => Array.from(pixels.slice((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));
const render = async (d: Doc) => {
  const r = await renderArtboard(d, "a", { loader });
  expect(r.warnings).toEqual([]);
  return r.pixels;
};

beforeAll(async () => {
  files["red.png"] = await sharp({ create: { width: 8, height: 8, channels: 4, background: "#FF0000" } }).png().toBuffer();
});

describe("Other › Color to Alpha", () => {
  it("drops white to transparency and keeps ink as ink", async () => {
    const pixels = await render(
      doc([{ kind: "color-to-alpha" }], [rect("paper", "#FFFFFF", { x: 0, y: 0, w: SIZE, h: SIZE }), rect("ink", "#000000", { x: 10, y: 10, w: 20, h: 20 }), rect("grey", "#808080", { x: 60, y: 60, w: 20, h: 20 })]),
    );
    expect(px(pixels, 50, 5)[3]).toBe(0);
    expect(px(pixels, 20, 20)).toEqual([0, 0, 0, 255]);
    // Mid-grey on white is black ink at half strength.
    const grey = px(pixels, 70, 70);
    expect(Math.abs(grey[3]! - 127)).toBeLessThanOrEqual(3);
  });
});

describe("Render › Picture Frame", () => {
  it("frames the layer and leaves the picture inside", async () => {
    const pixels = await render(doc([{ kind: "picture-frame", style: "flat", color: "#FF0000", width: 8 }], [rect("pic", "#0000FF", { x: 0, y: 0, w: SIZE, h: SIZE })]));
    expect(px(pixels, 3, 50)).toEqual([255, 0, 0, 255]);
    expect(px(pixels, 50, 96)).toEqual([255, 0, 0, 255]);
    expect(px(pixels, 50, 50)).toEqual([0, 0, 255, 255]);
    // The frame casts a soft shadow just inside it.
    expect(px(pixels, 9, 50)[2]).toBeLessThan(255);
  });
});

describe("Vanishing Point", () => {
  it("pastes an image across part of a plane", async () => {
    const plane: [[number, number], [number, number], [number, number], [number, number]] = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const pixels = await render(doc([{ kind: "vanishing-point", plane, paste: [{ asset: "red", rect: [0.25, 0.25, 0.75, 0.75] }] }], [rect("wall", "#0000FF", { x: 0, y: 0, w: SIZE, h: SIZE })], { red: { uri: "red.png", kind: "image" } }));
    expect(px(pixels, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(px(pixels, 10, 10)).toEqual([0, 0, 255, 255]);
  });

  it("clones a patch from one place on the plane to another", async () => {
    const plane: [[number, number], [number, number], [number, number], [number, number]] = [[0, 0], [1, 0.2], [1, 0.8], [0, 1]];
    const pixels = await render(doc([{ kind: "vanishing-point", plane, stamps: [{ from: [0.2, 0.5], to: [0.8, 0.5], size: 0.2 }] }], halves()));
    // Where the plane's (0.8, 0.5) lands in the image: the far side of the plane is foreshortened.
    const [cx, cy] = project(rectToQuad(1, 1, plane.map(([x, y]) => [x * SIZE, y * SIZE]) as typeof plane), [0.8, 0.5]).map(Math.floor) as [number, number];
    expect(px(pixels, cx, cy)[0]).toBeGreaterThan(240);
    expect(px(pixels, cx, cy - 30)[0]).toBeLessThan(15);
  });
});

describe("Adaptive Wide Angle", () => {
  it("straightens a fisheye from the centre out: the centre stays, the edges spread", async () => {
    const plain = await render(doc([], halves(0.75)));
    const fixed = await render(doc([{ kind: "adaptive-wide-angle", correction: "fisheye", focalLength: 8 }], halves(0.75)));
    expect(px(fixed, 50, 50)).toEqual(px(plain, 50, 50));
    // The white–black edge at 75% moves outwards, so just right of it is still white.
    expect(px(plain, 80, 50)[0]).toBe(0);
    expect(px(fixed, 80, 50)[0]).toBeGreaterThan(200);
  });
});

describe("Render › Tree", () => {
  const ground = () => [rect("sky", "#808080", { x: 0, y: 0, w: SIZE, h: SIZE })];
  it("grows a leafy tree from its base, a different one for each seed", async () => {
    const one = await render(doc([{ kind: "tree", seed: 1 }], ground()));
    const two = await render(doc([{ kind: "tree", seed: 2 }], ground()));
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
    let green = 0;
    for (let i = 0; i < one.length; i += 4) if (one[i + 1]! > one[i]! + 15 && one[i + 1]! > one[i + 2]! + 15) green++;
    expect(green).toBeGreaterThan(400);
    // The trunk stands at the bottom centre, in bark brown.
    const trunk = px(one, 50, 97);
    expect(trunk[0]).toBeLessThan(110);
    expect(trunk[0]! - trunk[2]!).toBeGreaterThan(5);
  });

  it("leaves a bare tree bare", async () => {
    const bare = await render(doc([{ kind: "tree", type: "bare", seed: 1 }], ground()));
    let green = 0;
    for (let i = 0; i < bare.length; i += 4) if (bare[i + 1]! > bare[i]! + 15) green++;
    expect(green).toBe(0);
  });
});

describe("Render › Flame", () => {
  it("burns above its path in fire colours", async () => {
    const pixels = await render(doc([{ kind: "flame", path: [[0.2, 0.9], [0.8, 0.9]], length: 40 }], [rect("night", "#101020", { x: 0, y: 0, w: SIZE, h: SIZE })]));
    let fire = 0;
    for (let y = 55; y < 90; y++)
      for (let x = 20; x < 80; x++) {
        const [r, , b] = px(pixels, x, y);
        if (r! > b! + 80) fire++;
      }
    expect(fire).toBeGreaterThan(300);
    // Nothing burns near the top.
    expect(px(pixels, 50, 5)).toEqual(px(await render(doc([], [rect("night", "#101020", { x: 0, y: 0, w: SIZE, h: SIZE })])), 50, 5));
  });
});

describe("Filter Gallery › Sketch", () => {
  it("draws in the foreground and background colours", async () => {
    const pixels = await render(doc([{ kind: "stamp", colors: ["#FF0000", "#0000FF"] }], halves()));
    for (let i = 0; i < pixels.length; i += 4) expect(pixels[i + 1]).toBeLessThanOrEqual(2);
    expect(px(pixels, 10, 50)).toEqual([0, 0, 255, 255]);
    expect(px(pixels, 90, 50)).toEqual([255, 0, 0, 255]);
  });
});
