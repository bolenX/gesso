import type { Doc, Effect, Layer } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderArtboard, type AssetLoader } from "../src/index.js";

const W = 60;
const px = (pixels: Uint8Array, x: number, y: number) => Array.from(pixels.slice((y * W + x) * 4, (y * W + x) * 4 + 3));
const lum = (c: number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;

/** A mid-grey square (10..50) on white, with effects. */
const doc = (effects: Effect[]): Doc => ({
  id: "fx",
  revision: 0,
  assets: { dots: { uri: "dots.png", kind: "image" } },
  artboards: [
    {
      id: "a",
      name: "A",
      frame: { x: 0, y: 0, w: W, h: W },
      background: "#FFFFFF",
      layers: [{ id: "sq", name: "sq", type: "shape", shape: { kind: "rect" }, fill: "#808080", frame: { x: 10, y: 10, w: 40, h: 40 }, effects } as Layer],
    },
  ],
});

let loader: AssetLoader;
const render = async (effects: Effect[]) => (await renderArtboard(doc(effects), "a", { loader })).pixels;

describe("layer styles", async () => {
  // A 4×4 tile: one red pixel, the rest white.
  const tile = await sharp(Buffer.from([...[255, 0, 0, 255], ...Array(15).fill([255, 255, 255, 255]).flat()]), { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
  loader = async () => tile;

  it("puts an inner shadow inside the edge away from the light", async () => {
    // Light from the upper left (120°): the shadow falls inside the top and left edges.
    const out = await render([{ kind: "inner-shadow", distance: 4, size: 4, opacity: 1 }]);
    expect(lum(px(out, 12, 30))).toBeLessThan(80);
    expect(lum(px(out, 47, 30))).toBeGreaterThan(120);
    expect(px(out, 5, 30)).toEqual([255, 255, 255]);
  });

  it("glows inside from the edges or the centre", async () => {
    const edge = await render([{ kind: "inner-glow", color: "#FFFFFF", size: 6, opacity: 1 }]);
    expect(lum(px(edge, 11, 30))).toBeGreaterThan(lum(px(edge, 30, 30)) + 40);
    const centre = await render([{ kind: "inner-glow", color: "#FFFFFF", size: 6, opacity: 1, source: "center" }]);
    expect(lum(px(centre, 30, 30))).toBeGreaterThan(lum(px(centre, 11, 30)) + 40);
  });

  it("lights a bevel's upper-left edge and shades the lower-right", async () => {
    const out = await render([{ kind: "bevel", size: 6, highlightOpacity: 1, shadowOpacity: 1 }]);
    expect(lum(px(out, 12, 30))).toBeGreaterThan(160);
    expect(lum(px(out, 47, 30))).toBeLessThan(90);
    expect(lum(px(out, 30, 30))).toBeCloseTo(128, -1);
    expect(px(out, 5, 30)).toEqual([255, 255, 255]);
    const outer = await render([{ kind: "bevel", style: "outer-bevel", size: 6, highlightOpacity: 1, shadowOpacity: 1 }]);
    expect(lum(px(outer, 52, 30))).toBeLessThan(200);
    expect(lum(px(outer, 30, 30))).toBeCloseTo(128, -1);
  });

  it("overlays a gradient across the layer's box", async () => {
    const out = await render([{ kind: "gradient-overlay", angle: 0, stops: [{ offset: 0, color: "#FF0000" }, { offset: 1, color: "#0000FF" }] }]);
    expect(px(out, 11, 30)[0]).toBeGreaterThan(230);
    expect(px(out, 48, 30)[2]).toBeGreaterThan(230);
    expect(px(out, 5, 30)).toEqual([255, 255, 255]);
  });

  it("tiles a pattern over the layer only", async () => {
    const out = await render([{ kind: "pattern-overlay", asset: "dots" }]);
    expect(px(out, 12, 12)).toEqual([255, 0, 0]);
    expect(px(out, 13, 12)).toEqual([255, 255, 255]);
    expect(px(out, 4, 4)).toEqual([255, 255, 255]);
  });

  it("satins and colour-overlays in a blend mode", async () => {
    const satin = await render([{ kind: "satin", opacity: 1, size: 6, distance: 8 }]);
    expect(Buffer.from(satin).equals(Buffer.from(await render([])))).toBe(false);
    const multiplied = await render([{ kind: "color-overlay", color: "#FF0000", blend: "multiply" }]);
    expect(px(multiplied, 30, 30)).toEqual([128, 0, 0]);
  });
});
