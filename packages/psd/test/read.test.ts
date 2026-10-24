import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Doc, Layer } from "@gesso/core";
import { renderArtboard } from "@gesso/render";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { importPsd, writePsd } from "../src/index.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

async function sample(): Promise<{ doc: Doc; files: Record<string, Uint8Array> }> {
  const photo = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#3080C0" } }).png().toBuffer();
  const doc: Doc = {
    id: "round",
    revision: 4,
    assets: {
      photo: { uri: "photo.png", kind: "image" },
      ...(existsSync(FONT) ? { bold: { uri: FONT, kind: "font" as const, family: "DejaVu Sans Bold", postscriptName: "DejaVuSans-Bold" } } : {}),
    },
    symbols: { card: { id: "card", name: "Card", size: [60, 40], background: "#FFC21A", layers: [] } },
    artboards: [
      {
        id: "post",
        name: "Post",
        frame: { x: 0, y: 0, w: 200, h: 160 },
        background: "#F3EDE4",
        layers: [
          { id: "photo", name: "Photo", type: "image", asset: "photo", fit: "fill", frame: { x: 10, y: 10, w: 80, h: 60 }, opacity: 0.8 },
          { id: "tint", name: "Tint", type: "adjustment", adjustment: { kind: "hue-saturation", hue: 20, saturation: -30, lightness: 0 }, frame: { x: 0, y: 0, w: 200, h: 160 } },
          {
            id: "badges",
            name: "Badges",
            type: "group",
            frame: { x: 0, y: 0, w: 200, h: 160 },
            children: [
              { id: "dot", name: "Dot", type: "shape", shape: { kind: "ellipse" }, fill: "#2440E6", frame: { x: 120, y: 20, w: 50, h: 50 }, effects: [{ kind: "drop-shadow", distance: 4, size: 6 }] },
              { id: "tri", name: "Tri", type: "shape", shape: { kind: "path", d: "M 0 30 L 15 0 L 30 30 Z" }, fill: "#FF4F1A", stroke: { paint: "#111110", width: 2 }, frame: { x: 150, y: 100, w: 30, h: 30 } },
            ],
          },
          { id: "box", name: "Box", type: "shape", shape: { kind: "rect" }, fill: "#111110", frame: { x: 20, y: 120, w: 60, h: 20 }, blend: "multiply" },
          { id: "card", name: "Card", type: "smart", symbol: "card", frame: { x: 100, y: 80, w: 60, h: 40 }, quad: [[100, 80], [160, 85], [160, 125], [100, 120]] },
          ...(existsSync(FONT)
            ? [{ id: "title", name: "Title", type: "text" as const, content: "Hello there", style: { font: "DejaVu Sans Bold", size: 18, fill: "#111110" }, runs: [{ text: "Hello " }, { text: "there", fill: "#FF4F1A" }], frame: { x: 10, y: 80, w: 120, h: 30 } }]
            : []),
        ],
      },
    ],
  };
  return { doc, files: { "photo.png": photo } };
}

const ids = (layers: Layer[]): string[] => layers.flatMap((l) => [`${l.id}:${l.type}`, ...(l.type === "group" ? ids(l.children) : [])]);

describe("importPsd", () => {
  it("round-trips a Gesso PSD with layers editable and pixels close", async () => {
    const { doc, files } = await sample();
    const loader = async ({ uri }: { uri: string }) => files[uri] ?? readFile(uri);
    const psd = await writePsd(doc, { loader });
    const dir = await mkdtemp(join(tmpdir(), "gesso-import-"));
    const { doc: back, warnings } = await importPsd(psd.bytes, {
      id: "round",
      assetDir: join(dir, "imported"),
      uriBase: "imported",
      findFont: async (ps) => (ps === "DejaVuSans-Bold" ? { uri: FONT, family: "DejaVu Sans Bold" } : undefined),
    });
    expect(warnings.join(" / ")).toBe("");
    const board = back.artboards[0]!;
    expect(board).toMatchObject({ id: "post", frame: { x: 0, y: 0, w: 200, h: 160 }, background: "#F3EDE4" });
    expect(ids(board.layers)).toEqual(ids(doc.artboards[0]!.layers));
    const text = board.layers.find((l) => l.type === "text");
    if (text && text.type === "text") expect(text.runs?.[1]).toMatchObject({ text: "there", fill: "#FF4F1A" });
    expect(board.layers.find((l) => l.id === "box")).toMatchObject({ blend: "multiply", shape: { kind: "rect" } });

    const before = await renderArtboard(doc, "post", { loader });
    const after = await renderArtboard(back, "post", { loader: async ({ uri }) => readFile(uri.startsWith("/") ? uri : join(dir, uri)) });
    let diff = 0;
    for (let i = 0; i < before.pixels.length; i++) diff += Math.abs(before.pixels[i]! - after.pixels[i]!);
    // Average difference per channel, out of 255.
    expect(diff / before.pixels.length).toBeLessThan(2);
  });
});
