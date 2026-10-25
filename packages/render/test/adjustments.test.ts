import { Adjustment, type Doc, type Layer } from "@gesso/core";
import { describe, expect, it } from "vitest";
import { applyAdjustment, parseCube, renderArtboard, type AssetLoader } from "../src/index.js";

/** One example of every adjustment layer kind. */
export const ADJUSTMENTS: Adjustment[] = [
  { kind: "brightness-contrast", brightness: 20, contrast: 30 },
  { kind: "hue-saturation", hue: 0, saturation: 0, lightness: 0, ranges: { blues: { hue: 60, saturation: 20 } } },
  { kind: "curves", points: [[0, 0], [128, 150], [255, 255]], red: [[0, 0], [128, 100], [255, 255]] },
  { kind: "gradient-map", stops: [{ offset: 0, color: "#1D2B64" }, { offset: 1, color: "#F8CDDA" }] },
  { kind: "levels", channel: "blue", inputBlack: 20, inputWhite: 230, gamma: 1.3 },
  { kind: "exposure", exposure: 0.8, gamma: 1.1 },
  { kind: "vibrance", vibrance: 60, saturation: 10 },
  { kind: "color-balance", shadows: [0, 0, 40], highlights: [30, 0, -30] },
  { kind: "black-white", tint: "#C8A070" },
  { kind: "photo-filter", color: "#EC8A00", density: 40 },
  { kind: "channel-mixer", red: [80, 20, 0, 0], blue: [0, 30, 70, 0] },
  { kind: "color-lookup", lut: "film" },
  { kind: "invert" },
  { kind: "posterize", levels: 4 },
  { kind: "threshold", level: 128 },
  { kind: "selective-color", reds: [-30, 20, 30, 0], neutrals: [0, 0, 10, 5] },
];

/** A 2³ .cube that swaps red and blue. */
export const SWAP_CUBE = `TITLE "swap"\nLUT_3D_SIZE 2\n${[0, 1].flatMap((b) => [0, 1].flatMap((g) => [0, 1].map((r) => `${b} ${g} ${r}`))).join("\n")}\n`;

const one = (adjustment: Adjustment, rgb: [number, number, number], luts?: Parameters<typeof applyAdjustment>[2]) => {
  const px = new Uint8Array([...rgb, 255]);
  applyAdjustment(px, adjustment, luts);
  return Array.from(px.slice(0, 3));
};

describe("adjustments", () => {
  it("has an example of every kind, each valid", () => {
    const kinds = Adjustment.options.map((o) => o.shape.kind.value);
    expect(ADJUSTMENTS.map((a) => a.kind).sort()).toEqual([...kinds].sort());
    for (const a of ADJUSTMENTS) expect(Adjustment.safeParse(a).success, a.kind).toBe(true);
  });

  it("renders every adjustment layer deterministically, changing what's below", async () => {
    const files: Record<string, Uint8Array> = { "film.cube": new TextEncoder().encode(SWAP_CUBE) };
    const loader: AssetLoader = async ({ uri }) => files[uri]!;
    const doc = (adjustment?: Adjustment): Doc => ({
      id: "a",
      revision: 0,
      assets: { film: { uri: "film.cube", kind: "lut" } },
      artboards: [
        {
          id: "a",
          name: "A",
          frame: { x: 0, y: 0, w: 60, h: 40 },
          layers: [
            { id: "bg", name: "bg", type: "shape", shape: { kind: "rect" }, fill: { kind: "linear-gradient", angle: 0, stops: [{ offset: 0, color: "#1040C0" }, { offset: 0.5, color: "#E0A040" }, { offset: 1, color: "#F0F0F0" }] }, frame: { x: 0, y: 0, w: 60, h: 40 } },
            { id: "red", name: "red", type: "shape", shape: { kind: "ellipse" }, fill: "#D02020", frame: { x: 5, y: 5, w: 20, h: 20 } },
            ...(adjustment ? [{ id: "adj", name: "adj", type: "adjustment", adjustment, frame: { x: 0, y: 0, w: 60, h: 40 } } as Layer] : []),
          ],
        },
      ],
    });
    const plain = await renderArtboard(doc(), "a", { loader });
    for (const adjustment of ADJUSTMENTS) {
      const [a, b] = [await renderArtboard(doc(adjustment), "a", { loader }), await renderArtboard(doc(adjustment), "a", { loader })];
      expect(a.warnings, adjustment.kind).toEqual([]);
      expect(Buffer.from(a.pixels).equals(Buffer.from(b.pixels)), adjustment.kind).toBe(true);
      expect(Buffer.from(a.pixels).equals(Buffer.from(plain.pixels)), `${adjustment.kind} changes the image`).toBe(false);
    }
  });

  it("matches Photoshop's Black & White defaults", () => {
    // Red 40%, yellow 60%, blue 20%; white and grey stay.
    expect(one({ kind: "black-white" }, [255, 0, 0])).toEqual([102, 102, 102]);
    expect(one({ kind: "black-white" }, [255, 255, 0])).toEqual([153, 153, 153]);
    expect(one({ kind: "black-white" }, [0, 0, 255])).toEqual([51, 51, 51]);
    expect(one({ kind: "black-white" }, [128, 128, 128])).toEqual([128, 128, 128]);
  });

  it("inverts, thresholds and posterizes exactly", () => {
    expect(one({ kind: "invert" }, [10, 128, 250])).toEqual([245, 127, 5]);
    expect(one({ kind: "threshold", level: 128 }, [200, 200, 200])).toEqual([255, 255, 255]);
    expect(one({ kind: "threshold", level: 128 }, [60, 60, 60])).toEqual([0, 0, 0]);
    expect(one({ kind: "posterize", levels: 2 }, [100, 130, 255])).toEqual([0, 255, 255]);
  });

  it("works in linear light for Exposure: +1 stop doubles the light", () => {
    // sRGB 128 is 0.216 linear; doubled, 0.432, which is sRGB 175.6.
    expect(one({ kind: "exposure", exposure: 1 }, [128, 128, 128])).toEqual([176, 176, 176]);
    expect(one({ kind: "exposure", exposure: 0 }, [77, 128, 200])).toEqual([77, 128, 200]);
  });

  it("keeps brightness with Photo Filter and Color Balance by default", () => {
    const lum = (c: number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
    const warm = one({ kind: "photo-filter", color: "#EC8A00", density: 50 }, [120, 140, 160]);
    expect(warm[0]! - warm[2]!).toBeGreaterThan(0);
    expect(Math.abs(lum(warm) - lum([120, 140, 160]))).toBeLessThan(2);
    const balanced = one({ kind: "color-balance", midtones: [50, 0, 0] }, [120, 120, 120]);
    expect(balanced[0]).toBeGreaterThan(balanced[1]!);
    expect(Math.abs(lum(balanced) - 120)).toBeLessThan(2);
  });

  it("limits Hue/Saturation range edits to that range", () => {
    const greensOnly = { kind: "hue-saturation", hue: 0, saturation: 0, lightness: 0, ranges: { greens: { saturation: -100 } } } as const;
    expect(one(greensOnly, [40, 200, 40])).toEqual([120, 120, 120]);
    expect(one(greensOnly, [200, 40, 40])).toEqual([200, 40, 40]);
  });

  it("reads .cube LUTs and looks colours up through them", () => {
    const lut = parseCube(SWAP_CUBE);
    expect(lut.size).toBe(2);
    expect(one({ kind: "color-lookup", lut: "x" }, [255, 128, 0], new Map([["x", lut]]))).toEqual([0, 128, 255]);
    expect(() => parseCube("LUT_1D_SIZE 4\n0 0 0")).toThrow(/1D/);
    expect(() => parseCube("LUT_3D_SIZE 2\n0 0 0")).toThrow(/8 entries/);
  });
});
