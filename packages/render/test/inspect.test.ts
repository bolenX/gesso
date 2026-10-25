import { describe, expect, it } from "vitest";
import { clippingMap, cropRendered, difference, measure, sampleAt, sideBySide, vectorscopeAngle, zoomRendered, type Rendered } from "../src/index.js";

/** A test image from a function of x and y returning RGBA. */
function image(w: number, h: number, at: (x: number, y: number) => [number, number, number, number?]): Rendered {
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = at(x, y);
      pixels.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return { artboard: "a", width: w, height: h, pixels, warnings: [] };
}

/** Deterministic noise in −1..1. */
const noise = (x: number, y: number) => ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1) * 2 - 1;

describe("measure", () => {
  it("reads tonal range, clipping and the histogram", () => {
    // Left half black, right half a ramp up to white.
    const s = measure(image(64, 32, (x) => (x < 32 ? [0, 0, 0] : [((x - 32) * 255) / 31, ((x - 32) * 255) / 31, ((x - 32) * 255) / 31])));
    expect(s.luminance.clipped.shadows).toBeGreaterThan(50);
    expect(s.luminance.clipped.highlights).toBeCloseTo(100 / 64, 1);
    expect(s.luminance.range).toEqual([0, 255]);
    expect(s.luminance.histogram[0]).toBeGreaterThan(50);
    expect(s.luminance.histogram.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
  });

  it("names colour casts and measures chroma", () => {
    expect(measure(image(16, 16, () => [128, 128, 128])).color.cast).toBe("neutral");
    expect(measure(image(16, 16, () => [190, 140, 90])).color.cast).toMatch(/warm/);
    expect(measure(image(16, 16, () => [100, 130, 190])).color.cast).toMatch(/cool/);
    expect(measure(image(16, 16, () => [255, 0, 0])).color.chroma.mean).toBeGreaterThan(80);
  });

  it("tells sharp from soft, and estimates noise", () => {
    const edges = measure(image(64, 64, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? [255, 255, 255] : [0, 0, 0]));
    const flat = measure(image(64, 64, () => [128, 128, 128]));
    expect(edges.sharpness).toBeGreaterThan(flat.sharpness + 1000);
    expect(flat.noise).toBe(0);
    const grainy = measure(image(64, 64, (x, y) => {
      const v = 128 + 10 * noise(x, y);
      return [v, v, v];
    }));
    expect(grainy.noise).toBeGreaterThan(3);
    expect(grainy.noise).toBeLessThan(15);
  });

  it("weighs pixels by opacity", () => {
    const s = measure(image(10, 10, (x) => (x < 5 ? [255, 0, 0, 0] : [0, 0, 255, 255])));
    expect(s.transparent).toBe(50);
    expect(s.color.mean).toBe("#0000FF");
  });
});

describe("samples", () => {
  it("averages the eyedropper square and finds the skin-tone line", () => {
    const r = image(9, 9, (x) => (x === 4 ? [255, 255, 255] : [0, 0, 0]));
    expect(sampleAt(r, [4, 4], 1).hex).toBe("#FFFFFF");
    expect(sampleAt(r, [4, 4], 3).rgb).toEqual([85, 85, 85]);
    // A typical skin tone sits within a few degrees of the line; a green doesn't.
    const skin = sampleAt(image(1, 1, () => [224, 172, 140]), [0, 0]);
    expect(Math.abs(skin.vectorscope.fromSkinLine)).toBeLessThan(10);
    expect(Math.abs(vectorscopeAngle(60, 200, 60) - 123)).toBeGreaterThan(60);
    expect(() => sampleAt(r, [50, 50])).toThrow(/outside/);
  });
});

describe("views", () => {
  const r = image(4, 2, (x, y) => [x * 60, y * 100, 0]);

  it("crops and zooms pixel by pixel", () => {
    const part = cropRendered(r, { x: 1, y: 0, w: 2, h: 2 });
    expect([part.width, part.height]).toEqual([2, 2]);
    expect([...part.pixels.subarray(0, 3)]).toEqual([60, 0, 0]);
    const big = zoomRendered(part, 3);
    expect([big.width, big.height]).toEqual([6, 6]);
    // Pixel (4, 4) of the zoomed view is pixel (1, 1) of the crop.
    expect([...big.pixels.subarray((4 * 6 + 4) * 4, (4 * 6 + 4) * 4 + 3)]).toEqual([120, 100, 0]);
  });

  it("finds where two renders differ", () => {
    const after = image(4, 2, (x, y) => (x === 3 && y === 1 ? [255, 255, 255] : [x * 60, y * 100, 0]));
    const { stats, image: map } = difference(r, after);
    expect(stats.changed).toBe(12.5);
    expect(stats.bounds).toEqual({ x: 3, y: 1, w: 1, h: 1 });
    expect(stats.deltaE.max).toBeGreaterThan(20);
    expect(map.pixels[(1 * 4 + 3) * 4]).toBe(255);
    expect(map.pixels[0]).toBe(0);
    expect(sideBySide(r, after, 2).width).toBe(10);
  });

  it("marks clipped pixels", () => {
    const map = clippingMap(image(3, 1, (x) => [[255, 200, 200], [100, 100, 100], [0, 50, 50]][x] as [number, number, number]));
    expect([...map.pixels.subarray(0, 3)]).toEqual([255, 0, 0]);
    expect([...map.pixels.subarray(8, 11)]).toEqual([0, 90, 255]);
  });
});
