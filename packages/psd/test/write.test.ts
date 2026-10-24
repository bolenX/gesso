import { existsSync } from "node:fs";
import type { Doc } from "@gesso/core";
import { readPsd, type Layer as PsdLayer } from "ag-psd";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { shapeKnots, writePsd } from "../src/index.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

async function campaign(): Promise<{ doc: Doc; loader: (a: { uri: string }) => Promise<Uint8Array> }> {
  const photo = await sharp({ create: { width: 40, height: 50, channels: 3, background: "#c08040" } }).png().toBuffer();
  const files: Record<string, Uint8Array> = { "photo.png": photo };
  const loader = async ({ uri }: { uri: string }) => files[uri] ?? (await import("node:fs/promises")).readFile(uri);
  const doc: Doc = {
    id: "promo-01",
    revision: 3,
    assets: {
      photo: { uri: "photo.png", kind: "image" },
      ...(existsSync(FONT) ? { sans: { uri: FONT, kind: "font" as const, family: "DejaVu Sans", postscriptName: "DejaVuSans" } } : {}),
    },
    artboards: [
      {
        id: "post-4x5",
        name: "Post 4:5",
        frame: { x: 0, y: 0, w: 108, h: 135 },
        background: "#F3EDE4",
        layers: [
          { id: "card", name: "Card", type: "shape", frame: { anchor: "center", w: "80%", h: "60%" }, shape: { kind: "rect", radius: 8 }, fill: "#FFFFFF" },
          { id: "card-photo", name: "Card photo", type: "image", clip: true, blend: "multiply", asset: "photo", frame: { x: 0, y: 0, w: 108, h: 135 } },
          {
            id: "grade",
            name: "Grade",
            type: "adjustment",
            opacity: 0.5,
            frame: { x: 0, y: 0, w: 108, h: 135 },
            adjustment: { kind: "curves", points: [[0, 20], [255, 235]] },
          },
          {
            id: "lockup",
            name: "Lockup",
            type: "group",
            frame: { x: 0, y: 0, w: 108, h: 135 },
            children: [
              {
                id: "headline",
                name: "Headline",
                type: "text",
                content: "Summer Edit",
                style: { font: "DejaVu Sans", size: 14, fill: "#1D1D1F" },
                box: { kind: "area" },
                frame: { anchor: "bottom-left", margin: 8, w: 90, h: 20 },
              },
              {
                id: "dot",
                name: "Dot",
                type: "shape",
                frame: { x: 90, y: 8, w: 10, h: 10 },
                shape: { kind: "ellipse" },
                fill: "#E8572A",
                mask: { kind: "vector", shape: { kind: "rect" } },
              },
            ],
          },
        ],
      },
      { id: "story-9x16", name: "Story 9:16", frame: { x: 140, y: 0, w: 54, h: 96 }, layers: [] },
    ],
  };
  return { doc, loader };
}

const byName = (layers: PsdLayer[] | undefined, name: string) => layers?.find((l) => l.name === name);

describe("writePsd", () => {
  it("writes artboards, live layers and a composite that read back", async () => {
    const { doc, loader } = await campaign();
    const { bytes } = await writePsd(doc, { loader });
    const psd = readPsd(bytes, { useImageData: true });

    expect([psd.width, psd.height]).toEqual([194, 135]);
    expect(psd.children?.map((c) => c.name)).toEqual(["Post 4:5", "Story 9:16"]);
    const post = psd.children![0]!;
    expect(post.artboard?.rect).toEqual({ top: 0, left: 0, bottom: 135, right: 108 });
    expect(post.children?.map((l) => l.name)).toEqual(["Background", "Card", "Card photo", "Grade", "Lockup"]);

    const card = byName(post.children, "Card")!;
    expect(card.vectorFill).toMatchObject({ type: "color" });
    expect(card.vectorMask?.paths[0]?.knots).toHaveLength(8);

    const photo = byName(post.children, "Card photo")!;
    expect(photo).toMatchObject({ clipping: true, blendMode: "multiply" });
    expect(photo.imageData?.width).toBe(108);

    const grade = byName(post.children, "Grade")!;
    expect(grade.adjustment).toMatchObject({ type: "curves" });
    expect(grade.opacity).toBeCloseTo(0.5, 2);

    const lockup = byName(post.children, "Lockup")!;
    expect(lockup.blendMode).toBe("pass through");
    const headline = byName(lockup.children, "Headline")!;
    expect(headline.text).toMatchObject({ text: "Summer Edit", shapeType: "box" });
    expect(headline.text?.style?.font?.name).toBe(existsSync(FONT) ? "DejaVuSans" : "DejaVuSans");
    expect(byName(lockup.children, "Dot")!.mask?.imageData).toBeDefined();

    // Composite: the second artboard's area stays transparent, the first is painted.
    const at = (x: number, y: number) => Array.from(psd.imageData!.data.slice((y * 194 + x) * 4, (y * 194 + x) * 4 + 4));
    expect(at(2, 2)[3]).toBe(255);
    expect(at(120, 50)[3]).toBe(0);
  });

  it("warns that opaque blocks are not written yet", async () => {
    const { doc, loader } = await campaign();
    doc.unknown = [{ key: "lnk2", data: "" }];
    expect((await writePsd(doc, { loader })).warnings).toContain("opaque PSD blocks are not written yet; they were dropped");
  });
});

it("embeds smart layers as smart objects with their corner pin", async () => {
  const doc: Doc = {
    id: "mock",
    revision: 1,
    assets: {},
    symbols: { ui: { id: "ui", name: "Screen design", size: [40, 20], background: "#2D3BF0", layers: [] } },
    artboards: [
      {
        id: "scene",
        name: "Scene",
        frame: { x: 0, y: 0, w: 100, h: 100 },
        layers: [{ id: "screen", name: "Screen", type: "smart", symbol: "ui", frame: { x: 0, y: 0, w: 100, h: 100 }, quad: [[20, 10], [90, 30], [90, 70], [20, 90]] }],
      },
    ],
  };
  const psd = readPsd((await writePsd(doc)).bytes, { useImageData: true });
  const screen = psd.children![0]!.children![0]!;
  expect(screen.name).toBe("Screen");
  expect(screen.placedLayer).toMatchObject({ type: "raster", width: 40, height: 20 });
  expect(screen.placedLayer!.transform).toEqual([20, 10, 90, 30, 90, 70, 20, 90]);
  expect(psd.linkedFiles).toHaveLength(1);
  expect(psd.linkedFiles![0]).toMatchObject({ id: screen.placedLayer!.id, name: "Screen design.psd" });
  const inner = readPsd(psd.linkedFiles![0]!.data!, { useImageData: true });
  expect([inner.width, inner.height]).toEqual([40, 20]);
  expect(inner.artboards).toBeUndefined();
  expect(psd.imageResources?.xmpMetadata).toContain('xmp:CreatorTool="Gesso');
});

describe("shapeKnots", () => {
  it("builds clockwise ellipse knots with kappa handles", () => {
    const knots = shapeKnots({ kind: "ellipse" }, { x: 0, y: 0, w: 100, h: 100 })!;
    expect(knots.map((k) => k.points.slice(2, 4))).toEqual([
      [50, 0],
      [100, 50],
      [50, 100],
      [0, 50],
    ]);
    expect(knots[0]!.points[4]).toBeCloseTo(50 + 50 * 0.5523, 2);
  });

  it("leaves SVG paths to pixels", () => {
    expect(shapeKnots({ kind: "path", d: "M0 0 L10 10" }, { x: 0, y: 0, w: 10, h: 10 })).toBeUndefined();
  });
});

it("keeps rotated text and shapes live", async () => {
  const doc: Doc = {
    id: "turn",
    revision: 1,
    assets: existsSync(FONT) ? { sans: { uri: FONT, kind: "font", family: "DejaVu Sans", postscriptName: "DejaVuSans" } } : {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 100, h: 100 },
        layers: [
          { id: "bar", name: "Bar", type: "shape", shape: { kind: "rect" }, fill: "#FF0000", frame: { x: 10, y: 45, w: 80, h: 10 }, rotation: 90 },
          ...(existsSync(FONT)
            ? [{ id: "t", name: "T", type: "text" as const, content: "Hi", style: { font: "DejaVu Sans", size: 20 }, frame: { x: 20, y: 40, w: 60, h: 20 }, rotation: 30 }]
            : []),
        ],
      },
    ],
  };
  const psd = readPsd((await writePsd(doc)).bytes, { useImageData: true });
  const [bar, text] = psd.children![0]!.children!;
  const corners = bar!.vectorMask!.paths[0]!.knots.map((k) => k.points.slice(2, 4).map((v) => Math.round(v)));
  expect(corners).toEqual([[55, 10], [55, 90], [45, 90], [45, 10]]);
  if (text) {
    const [a, b, c, d, e, f] = text.text!.transform!;
    expect([a, b, c, d].map((v) => +v.toFixed(3))).toEqual([0.866, 0.5, -0.5, 0.866]);
    // The box's top-left corner, turned 30° around the box centre (50, 50).
    expect([+e.toFixed(1), +f.toFixed(1)]).toEqual([29.0, 26.3]);
  }
});
