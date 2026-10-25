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
