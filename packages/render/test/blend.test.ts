import type { BlendMode, Doc, Layer } from "@gesso/core";
import { describe, expect, it } from "vitest";
import { renderArtboard } from "../src/index.js";

const px = (pixels: Uint8Array, x: number, y: number, w = 10) => Array.from(pixels.slice((y * w + x) * 4, (y * w + x) * 4 + 3));

/** A 10×10 backdrop of one colour with a layer of another on top in the given mode. */
async function blend(mode: BlendMode, below: string, above: string, opacity = 1) {
  const doc: Doc = {
    id: "b",
    revision: 0,
    assets: {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 10, h: 10 },
        layers: [
          { id: "below", name: "below", type: "shape", shape: { kind: "rect" }, fill: below, frame: { x: 0, y: 0, w: 10, h: 10 } },
          { id: "above", name: "above", type: "shape", shape: { kind: "rect" }, fill: above, frame: { x: 0, y: 0, w: 10, h: 10 }, blend: mode, opacity } as Layer,
        ],
      },
    ],
  };
  return (await renderArtboard(doc, "a")).pixels;
}

describe("Photoshop blend modes", () => {
  // Backdrop (153, 102, 51) is (0.6, 0.4, 0.2); source (102, 204, 153) is (0.4, 0.8, 0.6).
  const [below, above] = ["#996633", "#66CC99"];
  const cases: Array<[BlendMode, number[]]> = [
    ["linear-burn", [0, 51, 0]], // b + s − 1
    ["linear-dodge", [255, 255, 204]], // b + s
    ["linear-light", [102, 255, 102]], // b + 2s − 1
    ["subtract", [51, 0, 0]], // b − s
    ["divide", [255, 128, 85]], // b / s
    ["pin-light", [153, 153, 51]], // s < ½: min(b, 2s); else max(b, 2s − 1)
    ["hard-mix", [255, 255, 0]], // b + s ≥ 1
    ["vivid-light", [128, 255, 64]], // s ≤ ½: burn(b, 2s); else dodge(b, 2s − 1)
    ["darker-color", [153, 102, 51]], // the darker of the two colours as a whole
    ["lighter-color", [102, 204, 153]],
  ];
  for (const [mode, expected] of cases) {
    it(mode, async () => {
      const got = px(await blend(mode, below, above), 5, 5);
      got.forEach((v, c) => expect(Math.abs(v - expected[c]!), `${mode} channel ${c}: ${got}`).toBeLessThanOrEqual(2));
    });
  }

  it("dissolve shows each pixel fully or not at all, about as often as the opacity", async () => {
    const pixels = await blend("dissolve", "#000000", "#FFFFFF", 0.5);
    let white = 0;
    for (let i = 0; i < 100; i++) {
      const v = pixels[i * 4]!;
      expect(v === 0 || v === 255, `pixel ${i} is ${v}`).toBe(true);
      if (v === 255) white++;
    }
    expect(white).toBeGreaterThan(30);
    expect(white).toBeLessThan(70);
  });
});
