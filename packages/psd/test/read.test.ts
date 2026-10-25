import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adjustment, Doc, Effect, Layer } from "@gesso/core";
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

const ADJUSTMENTS: Adjustment[] = [
  { kind: "brightness-contrast", brightness: 20, contrast: 30 },
  { kind: "hue-saturation", hue: 10, saturation: 5, lightness: 0, ranges: { blues: { hue: 60, saturation: 20, lightness: 0 } } },
  { kind: "curves", points: [[0, 0], [128, 150], [255, 255]], red: [[0, 0], [128, 100], [255, 255]] },
  { kind: "gradient-map", stops: [{ offset: 0, color: "#1D2B64" }, { offset: 1, color: "#F8CDDA" }] },
  { kind: "levels", channel: "blue", inputBlack: 20, inputWhite: 230, gamma: 1.3, outputBlack: 0, outputWhite: 255 },
  { kind: "exposure", exposure: 0.8, gamma: 1.1 },
  { kind: "vibrance", vibrance: 60, saturation: 10 },
  { kind: "color-balance", shadows: [0, 0, 40], highlights: [30, 0, -30], preserveLuminosity: true },
  { kind: "black-white", reds: 40, yellows: 60, greens: 40, cyans: 60, blues: 20, magentas: 80, tint: "#C8A070" },
  { kind: "photo-filter", color: "#EC8A00", density: 40, preserveLuminosity: true },
  { kind: "channel-mixer", red: [80, 20, 0, 0], green: [0, 100, 0, 0], blue: [0, 30, 70, 0] },
  { kind: "color-lookup", lut: "film" },
  { kind: "invert" },
  { kind: "posterize", levels: 4 },
  { kind: "threshold", level: 128 },
  { kind: "selective-color", mode: "relative", reds: [-30, 20, 30, 0], neutrals: [0, 0, 10, 5] },
];
const CUBE = `LUT_3D_SIZE 2\n${[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${b} ${g} ${r}`))).join("\n")}\n`;

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

  it("keeps every adjustment layer live through a PSD, LUTs included", async () => {
    const files: Record<string, Uint8Array> = { "film.cube": new TextEncoder().encode(CUBE) };
    const doc: Doc = {
      id: "adj",
      revision: 0,
      assets: { film: { uri: "film.cube", kind: "lut" } },
      artboards: [
        {
          id: "a",
          name: "A",
          frame: { x: 0, y: 0, w: 40, h: 40 },
          background: "#808080",
          layers: ADJUSTMENTS.map((adjustment, i) => ({ id: `adj-${i}`, name: adjustment.kind, type: "adjustment", adjustment, frame: { x: 0, y: 0, w: 40, h: 40 }, visible: false }) as Layer),
        },
      ],
    };
    const psd = await writePsd(doc, { loader: async ({ uri }) => files[uri]! });
    const dir = await mkdtemp(join(tmpdir(), "gesso-adj-"));
    const { doc: back, warnings } = await importPsd(psd.bytes, { id: "adj", assetDir: dir, uriBase: "imported" });
    expect(warnings).toEqual([]);
    const adjustments = back.artboards[0]!.layers.map((l) => (l.type === "adjustment" ? l.adjustment : undefined));
    const lut = adjustments.find((a) => a?.kind === "color-lookup");
    const lutId = lut?.kind === "color-lookup" ? lut.lut : "";
    expect(adjustments).toEqual(ADJUSTMENTS.map((a) => (a.kind === "color-lookup" ? { kind: "color-lookup", lut: lutId } : a)));
    expect(back.assets[lutId]).toMatchObject({ kind: "lut", uri: `imported/${lutId}.cube` });
    expect(await readFile(join(dir, `${lutId}.cube`), "utf8")).toBe(CUBE);
  });

  it("keeps Blend If and Photoshop blend modes live, and bakes computed masks", async () => {
    const rect = (id: string, fill: string, x: number, extra: object = {}) => ({ id, name: id, type: "shape", shape: { kind: "rect" }, fill, frame: { x, y: 0, w: x ? 10 : 20, h: 10 }, ...extra }) as Layer;
    const doc: Doc = {
      id: "ranges",
      revision: 0,
      assets: {},
      artboards: [
        {
          id: "a",
          name: "A",
          frame: { x: 0, y: 0, w: 20, h: 10 },
          layers: [
            rect("dark", "#000000", 0),
            rect("light", "#FFFFFF", 10),
            rect("burn", "#FF8800", 0, { blend: "linear-burn", blendIf: { underlying: [0, 0, 100, 140], this: [10, 30, 255, 255] } }),
            rect("lit", "#00FF00", 0, { blend: "vivid-light", mask: { kind: "luminosity", range: "lights" } }),
          ],
        },
      ],
    };
    const psd = await writePsd(doc);
    const dir = await mkdtemp(join(tmpdir(), "gesso-ranges-"));
    const { doc: back } = await importPsd(psd.bytes, { id: "ranges", assetDir: dir, uriBase: "imported" });
    const [, , burn, lit] = back.artboards[0]!.layers;
    expect(burn).toMatchObject({ blend: "linear-burn", blendIf: { underlying: [0, 0, 100, 140], this: [10, 30, 255, 255] } });
    expect(lit).toMatchObject({ blend: "vivid-light", mask: { kind: "raster" } });
    // The baked mask covers the white half (lights) and not the black half.
    const mask = lit!.mask!.kind === "raster" ? lit!.mask!.asset : "";
    const { data, info } = await sharp(join(dir, `${mask}.png`)).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
    expect(data[5]).toBeLessThan(10);
    expect(data[info.width - 3]).toBeGreaterThan(245);
  });

  it("keeps the new layer styles live through a PSD; pattern overlays become a clipped layer", async () => {
    const effects: Effect[] = [
      { kind: "inner-shadow", color: "#101020", opacity: 0.6, angle: 135, distance: 4, size: 6, choke: 0.2 },
      { kind: "inner-glow", color: "#FFF4C0", opacity: 0.8, size: 8, source: "center" },
      { kind: "bevel", style: "pillow-emboss", depth: 150, direction: "down", size: 7, soften: 2, angle: 100, altitude: 40, highlight: "#FFFFF0", highlightOpacity: 0.7, shadow: "#200010", shadowOpacity: 0.6 },
      { kind: "satin", color: "#002040", opacity: 0.4, angle: 30, distance: 9, size: 12, invert: true },
      { kind: "gradient-overlay", stops: [{ offset: 0, color: "#FF4F1A" }, { offset: 1, color: "#2440E6" }], angle: 45, style: "reflected", scale: 80, reverse: true, opacity: 0.5, blend: "overlay" },
      { kind: "color-overlay", color: "#00FF00", opacity: 0.3, blend: "multiply" },
      { kind: "pattern-overlay", asset: "dots", opacity: 0.5 },
    ];
    const tile = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#FF0000" } }).png().toBuffer();
    const doc: Doc = {
      id: "styles",
      revision: 0,
      assets: { dots: { uri: "dots.png", kind: "image" } },
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 60, h: 60 }, layers: [{ id: "sq", name: "Square", type: "shape", shape: { kind: "rect" }, fill: "#808080", frame: { x: 10, y: 10, w: 40, h: 40 }, effects } as Layer] }],
    };
    const psd = await writePsd(doc, { loader: async () => tile });
    expect(psd.warnings.join(" ")).toMatch(/pattern overlay/);
    const dir = await mkdtemp(join(tmpdir(), "gesso-styles-"));
    const { doc: back } = await importPsd(psd.bytes, { id: "styles", assetDir: dir, uriBase: "imported" });
    const [square, overlay] = back.artboards[0]!.layers;
    // Effects stack by kind (as in Photoshop), so their order in the list doesn't matter.
    const byKind = (list: Effect[]) => [...list].sort((a, b) => a.kind.localeCompare(b.kind));
    expect(byKind(square!.effects!)).toEqual(byKind(effects.filter((e) => e.kind !== "pattern-overlay")));
    expect(overlay).toMatchObject({ name: "Square · pattern overlay", type: "image", clip: true });
    expect(overlay!.opacity).toBeCloseTo(0.5, 2);
  });
});
