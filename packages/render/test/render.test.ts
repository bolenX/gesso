import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Doc, Layer } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { curveLut, encode, renderArtboard, resolveFrame, type AssetLoader } from "../src/index.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

/** Solid-colour PNG fixtures, generated in memory. */
async function solid(r: number, g: number, b: number, w = 20, h = 10): Promise<Uint8Array> {
  return sharp({ create: { width: w, height: h, channels: 4, background: { r, g, b, alpha: 1 } } }).png().toBuffer();
}

function docWith(layers: Layer[], assets: Doc["assets"] = {}): Doc {
  return {
    id: "test",
    revision: 0,
    assets,
    artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 100, h: 100 }, layers }],
  };
}

const loaderFor =
  (files: Record<string, Uint8Array>): AssetLoader =>
  async ({ uri }) => {
    if (files[uri]) return files[uri];
    return readFile(uri);
  };

const rect = (id: string, fill: string, frame: Layer["frame"] = { x: 0, y: 0, w: 100, h: 100 }, extra: Partial<Layer> = {}): Layer =>
  ({ id, name: id, type: "shape", shape: { kind: "rect" }, fill, frame, ...extra }) as Layer;

const px = (pixels: Uint8Array, width: number, x: number, y: number) => Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

describe("resolveFrame", () => {
  const parent = { x: 0, y: 0, w: 1000, h: 500 };
  it("places anchored frames with margins and percentage sizes", () => {
    expect(resolveFrame({ anchor: "bottom-right", margin: 10, w: "20%", h: 50 }, parent)).toEqual({ x: 790, y: 440, w: 200, h: 50 });
    expect(resolveFrame({ anchor: "center", w: 100, aspect: 2 }, parent)).toEqual({ x: 450, y: 225, w: 100, h: 50 });
    expect(resolveFrame({ anchor: "top-left", margin: [20, 30] }, parent)).toEqual({ x: 20, y: 30, w: 960, h: 440 });
  });
  it("uses intrinsic aspect when only one side is given", () => {
    expect(resolveFrame({ anchor: "top", h: 100 }, parent, { aspect: 1.5 })).toEqual({ x: 425, y: 0, w: 150, h: 100 });
  });
});

describe("curveLut", () => {
  it("passes through its control points and inverts", () => {
    const lut = curveLut([
      [0, 255],
      [255, 0],
    ]);
    expect([lut[0], lut[128], lut[255]]).toEqual([255, 127, 0]);
  });
});

describe("renderArtboard", () => {
  it("draws drop shadows below and strokes around a layer", async () => {
    const box = rect("box", "#FFFFFF", { x: 30, y: 30, w: 40, h: 40 }, {
      effects: [
        { kind: "drop-shadow", color: "#000000", opacity: 1, angle: 90, distance: 10, size: 0 },
        { kind: "stroke", color: "#FF0000", width: 4 },
      ],
    });
    const out = await renderArtboard(docWith([box]), "a");
    expect(px(out.pixels, 100, 50, 50)).toEqual([255, 255, 255, 255]);
    expect(px(out.pixels, 100, 50, 28)).toEqual([255, 0, 0, 255]);
    // The shadow falls 10 px below the stroked box: its stroke ends at 74, the shadow at 84.
    expect(px(out.pixels, 100, 50, 80)).toEqual([0, 0, 0, 255]);
    expect(px(out.pixels, 100, 50, 90)[3]).toBe(0);
  });

  it("rotates a layer around the centre of its box", async () => {
    const out = await renderArtboard(docWith([rect("bar", "#FF0000", { x: 10, y: 45, w: 80, h: 10 }, { rotation: 90 })]), "a");
    expect(px(out.pixels, 100, 50, 15)).toEqual([255, 0, 0, 255]);
    expect(px(out.pixels, 100, 15, 50)[3]).toBe(0);
  });

  it("flips a group, children included", async () => {
    const group = {
      id: "pair", name: "pair", type: "group", flip: "horizontal", frame: { x: 0, y: 0, w: 100, h: 100 },
      children: [rect("left", "#FF0000", { x: 0, y: 0, w: 50, h: 100 }), rect("right", "#0000FF", { x: 50, y: 0, w: 50, h: 100 })],
    } as Layer;
    const out = await renderArtboard(docWith([group]), "a");
    expect(px(out.pixels, 100, 10, 50)).toEqual([0, 0, 255, 255]);
    expect(px(out.pixels, 100, 90, 50)).toEqual([255, 0, 0, 255]);
  });

  it("fills shapes and the artboard background", async () => {
    const doc = docWith([rect("box", "#FF0000", { x: 50, y: 0, w: 50, h: 100 })]);
    doc.artboards[0]!.background = "#0000FF";
    const out = await renderArtboard(doc, "a");
    expect([out.width, out.height]).toEqual([100, 100]);
    expect(px(out.pixels, 100, 10, 50)).toEqual([0, 0, 255, 255]);
    expect(px(out.pixels, 100, 75, 50)).toEqual([255, 0, 0, 255]);
  });

  it("blends in gamma-encoded space (multiply of 50% grey)", async () => {
    const out = await renderArtboard(
      docWith([rect("bg", "#808080"), rect("top", "#808080", undefined, { blend: "multiply" })]),
      "a",
    );
    // Encoded-space multiply: 128 * 128 / 255 ≈ 64. Linear-light blending would give ~55.
    expect(px(out.pixels, 100, 50, 50)[0]).toBeCloseTo(64, -0.5);
  });

  it("applies opacity", async () => {
    const out = await renderArtboard(docWith([rect("bg", "#000000"), rect("top", "#FFFFFF", undefined, { opacity: 0.5 })]), "a");
    expect(px(out.pixels, 100, 50, 50)[0]).toBeCloseTo(128, -0.5);
  });

  it("clips layers to the base layer's alpha", async () => {
    const files = { "photo.png": await solid(0, 255, 0) };
    const doc = docWith(
      [
        rect("card", "#FFFFFF", { x: 25, y: 25, w: 50, h: 50 }),
        { id: "photo", name: "Photo", type: "image", asset: "photo", clip: true, frame: { x: 0, y: 0, w: 100, h: 100 } },
      ],
      { photo: { uri: "photo.png", kind: "image" } },
    );
    const out = await renderArtboard(doc, "a", { loader: loaderFor(files) });
    expect(px(out.pixels, 100, 50, 50)).toEqual([0, 255, 0, 255]);
    expect(px(out.pixels, 100, 5, 5)[3]).toBe(0);
  });

  it("letterboxes images with fit=contain", async () => {
    const files = { "wide.png": await solid(255, 0, 0, 40, 10) };
    const doc = docWith(
      [{ id: "img", name: "Img", type: "image", asset: "wide", fit: "contain", frame: { x: 0, y: 0, w: 100, h: 100 } }],
      { wide: { uri: "wide.png", kind: "image" } },
    );
    const out = await renderArtboard(doc, "a", { loader: loaderFor(files) });
    // contain: 100×25 band centred vertically
    expect(px(out.pixels, 100, 50, 50)[3]).toBe(255);
    expect(px(out.pixels, 100, 50, 10)[3]).toBe(0);
  });

  it("masks with a vector shape", async () => {
    const masked = rect("box", "#FF0000", undefined, { mask: { kind: "vector", shape: { kind: "ellipse" } } });
    const out = await renderArtboard(docWith([masked]), "a");
    expect(px(out.pixels, 100, 50, 50)[3]).toBe(255);
    expect(px(out.pixels, 100, 2, 2)[3]).toBe(0);
  });

  it("keeps blurred edges the layer's colour (no dark halo)", async () => {
    const out = await renderArtboard(
      docWith([rect("s", "#F4A259", { x: 0, y: 0, w: 50, h: 100 }, { filters: [{ kind: "gaussian-blur", radius: 8 }] })]),
      "a",
    );
    const [r, g, b, a] = px(out.pixels, 100, 55, 50);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
    expect(Math.abs(r! - 0xf4) + Math.abs(g! - 0xa2) + Math.abs(b! - 0x59)).toBeLessThan(12);
  });

  it("applies adjustment layers to everything below", async () => {
    const out = await renderArtboard(
      docWith([
        rect("bg", "#204060"),
        {
          id: "invert",
          name: "Invert",
          type: "adjustment",
          frame: { x: 0, y: 0, w: 100, h: 100 },
          adjustment: { kind: "curves", points: [[0, 255], [255, 0]] },
        },
      ]),
      "a",
    );
    expect(px(out.pixels, 100, 50, 50)).toEqual([0xdf, 0xbf, 0x9f, 255]);
  });

  it("adjusts only inside a clip base", async () => {
    const out = await renderArtboard(
      docWith([
        rect("bg", "#000000"),
        rect("card", "#000000", { x: 0, y: 0, w: 50, h: 100 }),
        {
          id: "lift",
          name: "Lift",
          type: "adjustment",
          clip: true,
          frame: { x: 0, y: 0, w: 100, h: 100 },
          adjustment: { kind: "levels", inputBlack: 0, inputWhite: 255, gamma: 1, outputBlack: 100 },
        },
      ]),
      "a",
    );
    expect(px(out.pixels, 100, 25, 50)[0]).toBe(100);
    expect(px(out.pixels, 100, 75, 50)[0]).toBe(0);
  });

  it("renders at a preview scale and encodes", async () => {
    const out = await renderArtboard(docWith([rect("box", "#FF0000")]), "a", { scale: 0.25 });
    expect([out.width, out.height]).toEqual([25, 25]);
    const meta = await sharp(await encode(out, "webp")).metadata();
    expect([meta.format, meta.width]).toEqual(["webp", 25]);
  });

  it("warns when a font is missing", async () => {
    const out = await renderArtboard(
      docWith([
        { id: "t", name: "T", type: "text", content: "Hi", style: { font: "Nope", size: 20 }, frame: { anchor: "center" } },
      ]),
      "a",
    );
    expect(out.warnings[0]).toMatch(/font "Nope" is not loaded/);
  });

  it.skipIf(!existsSync(FONT))("renders text and warns on overflow", async () => {
    const doc = docWith(
      [
        {
          id: "headline",
          name: "Headline",
          type: "text",
          content: "Summer Edit Summer Edit Summer Edit",
          style: { font: "DejaVu Sans", size: 24, fill: "#000000" },
          box: { kind: "area" },
          frame: { x: 0, y: 0, w: 100, h: 30 },
        },
      ],
      { sans: { uri: FONT, kind: "font", family: "DejaVu Sans" } },
    );
    const out = await renderArtboard(doc, "a");
    const inked = Array.from({ length: 100 * 30 }, (_, i) => out.pixels[i * 4 + 3]!).filter((a) => a > 0).length;
    expect(inked).toBeGreaterThan(50);
    expect(out.warnings).toContain('text "headline" overflows its box');

    const fitted = structuredClone(doc);
    (fitted.artboards[0]!.layers[0] as { box: object }).box = { kind: "area", shrinkToFit: true, minSize: 6 };
    expect((await renderArtboard(fitted, "a")).warnings).toEqual([]);
  });
});

describe("smart layers", () => {
  const symbolDoc = (quad?: [number, number][]): Doc => ({
    ...docWith([
      { id: "screen", name: "Screen", type: "smart", symbol: "ui", frame: { x: 0, y: 0, w: 100, h: 100 }, ...(quad ? { quad: quad as never } : {}) } as Layer,
    ]),
    symbols: { ui: { id: "ui", name: "UI", size: [40, 20], background: "#00FF00", layers: [rect("half", "#FF0000", { x: 0, y: 0, w: 20, h: 20 })] } },
  });

  it("renders the symbol into its frame", async () => {
    const out = await renderArtboard(symbolDoc(), "a");
    expect(px(out.pixels, 100, 25, 50)).toEqual([255, 0, 0, 255]);
    expect(px(out.pixels, 100, 75, 50)).toEqual([0, 255, 0, 255]);
  });

  it("corner-pins the symbol in perspective", async () => {
    const out = await renderArtboard(symbolDoc([[20, 10], [90, 30], [90, 70], [20, 90]]), "a");
    expect(px(out.pixels, 100, 30, 50)).toEqual([255, 0, 0, 255]);
    expect(px(out.pixels, 100, 85, 50)[1]).toBe(255);
    expect(px(out.pixels, 100, 10, 50)[3]).toBe(0);
  });
});
