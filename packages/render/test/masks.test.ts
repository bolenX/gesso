import type { Doc, Layer } from "@gesso/core";
import { describe, expect, it } from "vitest";
import { renderArtboard, writeSvg } from "../src/index.js";

const px = (pixels: Uint8Array, x: number, y: number, w = 20) => Array.from(pixels.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
const rect = (id: string, fill: string, frame: Layer["frame"], extra: object = {}) => ({ id, name: id, type: "shape", shape: { kind: "rect" }, fill, frame, ...extra }) as Layer;

/** Left half black, right half white, with a red layer over everything that takes `extra`. */
const split = (extra: object, more: Layer[] = []): Doc => ({
  id: "m",
  revision: 0,
  assets: {},
  artboards: [
    {
      id: "a",
      name: "A",
      frame: { x: 0, y: 0, w: 20, h: 10 },
      layers: [rect("dark", "#000000", { x: 0, y: 0, w: 10, h: 10 }), rect("light", "#FFFFFF", { x: 10, y: 0, w: 10, h: 10 }), ...more, rect("paint", "#FF0000", { x: 0, y: 0, w: 20, h: 10 }, extra)],
    },
  ],
});

describe("computed masks", () => {
  it("shows a layer only over the lights of what's below (luminosity mask)", async () => {
    const out = (await renderArtboard(split({ mask: { kind: "luminosity", range: "lights" } }), "a")).pixels;
    expect(px(out, 15, 5)).toEqual([255, 0, 0]);
    expect(px(out, 5, 5)).toEqual([0, 0, 0]);
    const darks = (await renderArtboard(split({ mask: { kind: "luminosity", range: "darks" } }), "a")).pixels;
    expect(px(darks, 5, 5)).toEqual([255, 0, 0]);
    expect(px(darks, 15, 5)).toEqual([255, 255, 255]);
  });

  it("selects by colour (color range) from a named layer", async () => {
    const swatch = rect("swatch", "#2040C0", { x: 0, y: 0, w: 10, h: 10 }, { visible: false });
    const doc = split({ mask: { kind: "color-range", source: "swatch", color: "#2040C0", fuzziness: 40 } }, [swatch]);
    const out = (await renderArtboard(doc, "a")).pixels;
    expect(px(out, 5, 5)).toEqual([255, 0, 0]);
    expect(px(out, 15, 5)).toEqual([255, 255, 255]);
  });

  it("uses a channel with levels, inverted", async () => {
    // The green channel is 0 on the left and 255 on the right; inverted, the left shows.
    const out = (await renderArtboard(split({ mask: { kind: "channel", channel: "green", invert: true } }), "a")).pixels;
    expect(px(out, 5, 5)).toEqual([255, 0, 0]);
    expect(px(out, 15, 5)).toEqual([255, 255, 255]);
  });
});

describe("Blend If", () => {
  it("hides the layer where what's below is brighter than the range", async () => {
    const out = (await renderArtboard(split({ blendIf: { underlying: [0, 0, 100, 100] } }), "a")).pixels;
    expect(px(out, 5, 5)).toEqual([255, 0, 0]);
    expect(px(out, 15, 5)).toEqual([255, 255, 255]);
  });

  it("fades across split sliders", async () => {
    // A mid-grey backdrop (128) halfway between the white split (100) and white (156) shows half the layer.
    const doc = split({ blendIf: { underlying: [0, 0, 100, 156] } }, [rect("grey", "#808080", { x: 0, y: 0, w: 20, h: 10 })]);
    const [r] = px((await renderArtboard(doc, "a")).pixels, 5, 5);
    expect(Math.abs(r! - (128 + 255) / 2)).toBeLessThanOrEqual(3);
  });

  it("tests the layer's own pixels with 'this'", async () => {
    const out = (await renderArtboard(split({ blendIf: { channel: "red", this: [0, 0, 200, 200] } }), "a")).pixels;
    // The layer is pure red (255): above 200 in red, so it's hidden everywhere.
    expect(px(out, 5, 5)).toEqual([0, 0, 0]);
  });

  it("flattens backdrop-reading layers in SVG", async () => {
    const { warnings } = await writeSvg(split({ blendIf: { underlying: [0, 0, 100, 100] } }), "a");
    expect(warnings.join(" ")).toMatch(/flattened/);
  });
});

describe("compound shapes", () => {
  const ring = (op: "add" | "subtract" | "intersect" | "exclude"): Doc => ({
    id: "c",
    revision: 0,
    assets: {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 20, h: 10 },
        background: "#FFFFFF",
        layers: [
          {
            id: "s",
            name: "s",
            type: "shape",
            fill: "#000000",
            frame: { x: 0, y: 0, w: 20, h: 10 },
            shape: { kind: "compound", parts: [{ shape: { kind: "rect" }, frame: { x: 0, y: 0, w: 14, h: 10 } }, { shape: { kind: "rect" }, frame: { x: 6, y: 0, w: 14, h: 10 }, op }] },
          } as Layer,
        ],
      },
    ],
  });
  // Two overlapping bars, 0..14 and 6..20: probe the left-only, overlap and right-only parts.
  const probe = async (op: "add" | "subtract" | "intersect" | "exclude") => {
    const out = (await renderArtboard(ring(op), "a")).pixels;
    return [px(out, 2, 5)[0], px(out, 10, 5)[0], px(out, 17, 5)[0]];
  };
  it("adds, subtracts, intersects and excludes", async () => {
    expect(await probe("add")).toEqual([0, 0, 0]);
    expect(await probe("subtract")).toEqual([0, 255, 255]);
    expect(await probe("intersect")).toEqual([255, 0, 255]);
    expect(await probe("exclude")).toEqual([0, 255, 0]);
  });

  it("writes the combined outline as an SVG path", async () => {
    const { svg } = await writeSvg(ring("subtract"), "a");
    expect(svg).toMatch(/<path d="M0 0L6 0L6 10L0 10L0 0Z"|<path d="M[^"]+" fill="#000000"/);
    expect(svg).not.toMatch(/<image/);
  });
});

describe("transforms", () => {
  const square = (extra: object): Doc => ({
    id: "t",
    revision: 0,
    assets: {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 20, h: 10 },
        background: "#FFFFFF",
        layers: [{ id: "s", name: "s", type: "shape", shape: { kind: "rect" }, fill: "#000000", frame: { x: 5, y: 0, w: 10, h: 10 }, ...extra } as Layer],
      },
    ],
  });
  const ink = async (extra: object) => {
    const out = (await renderArtboard(square(extra), "a")).pixels;
    return (x: number, y: number) => px(out, x, y)[0]!;
  };

  it("skews around the centre", async () => {
    // 45° horizontal skew: the top row shifts left and the bottom row right by half the height.
    const at = await ink({ skew: [45, 0] });
    expect(at(2, 1)).toBeLessThan(60);
    expect(at(17, 1)).toBeGreaterThan(200);
    expect(at(17, 8)).toBeLessThan(60);
    expect(at(2, 8)).toBeGreaterThan(200);
  });

  it("pins corners with a quad (distort / perspective)", async () => {
    const at = await ink({ quad: [[0, 0], [20, 0], [12, 10], [8, 10]] });
    expect(at(3, 1)).toBeLessThan(60);
    expect(at(17, 1)).toBeLessThan(60);
    expect(at(2, 9)).toBeGreaterThan(200);
    expect(at(10, 9)).toBeLessThan(60);
  });

  it("leaves a layer unchanged under an even warp grid and bends it under a moved one", async () => {
    const even = [[[0, 0], [0.5, 0], [1, 0]], [[0, 0.5], [0.5, 0.5], [1, 0.5]], [[0, 1], [0.5, 1], [1, 1]]];
    const plain = (await renderArtboard(square({}), "a")).pixels;
    const flat = (await renderArtboard(square({ warp: even }), "a")).pixels;
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff += Math.abs(plain[i]! - flat[i]!);
    expect(diff / plain.length).toBeLessThan(2);
    const bulge = structuredClone(even);
    bulge[1]![2] = [1.8, 0.5];
    const at = await ink({ warp: bulge });
    expect(at(17, 5)).toBeLessThan(60);
    expect(at(17, 0)).toBeGreaterThan(200);
  });
});
