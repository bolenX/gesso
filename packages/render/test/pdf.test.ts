import { describe, expect, it } from "vitest";
import type { Doc } from "@gesso/core";
import { writePdf } from "../src/index.js";

const doc: Doc = {
  id: "flyer",
  revision: 1,
  assets: {},
  artboards: [
    { id: "front", name: "Front", preset: "a5", frame: { x: 0, y: 0, w: 1748, h: 2480 }, background: "#FF4F1A", layers: [{ id: "dot", name: "Dot", type: "shape", shape: { kind: "ellipse" }, fill: "#111110", frame: { x: 500, y: 500, w: 400, h: 400 } }] },
    { id: "post", name: "Post", frame: { x: 2000, y: 0, w: 1080, h: 1080 }, background: "#2440E6", layers: [] },
  ],
};

const boxes = (pdf: string, name: string) => [...pdf.matchAll(new RegExp(`/${name} \\[([^\\]]+)\\]`, "g"))].map((m) => m[1]!.trim().split(/\s+/).map(Number));

describe("writePdf", () => {
  it("writes a page per artboard, sized for print at 300 dpi for print presets", async () => {
    const { bytes } = await writePdf(doc);
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    const media = boxes(text, "MediaBox");
    expect(media).toHaveLength(2);
    // A5 at 300 dpi is 148 × 210 mm: 419.5 × 595.2 pt. The 1080 px post at 72 dpi is 1080 pt.
    expect(media[0]![2]).toBeCloseTo(419.52, 1);
    expect(media[0]![3]).toBeCloseTo(595.2, 1);
    expect(media[1]![2]).toBeCloseTo(1080, 1);
  });

  it("adds bleed, crop-mark room and the trim and bleed boxes", async () => {
    const { bytes } = await writePdf(doc, { artboards: ["front"], bleed: 3, marks: true });
    const text = Buffer.from(bytes).toString("latin1");
    const [media] = boxes(text, "MediaBox");
    const [trim] = boxes(text, "TrimBox");
    const [bleed] = boxes(text, "BleedBox");
    const mm3 = (3 * 72) / 25.4;
    expect(trim![2]! - trim![0]!).toBeCloseTo(419.52, 1);
    expect(trim![0]! - bleed![0]!).toBeCloseTo(mm3, 1);
    expect(bleed![0]).toBeCloseTo(24, 5);
    expect(media![2]).toBeCloseTo(419.52 + 2 * mm3 + 48, 1);
  });
});
