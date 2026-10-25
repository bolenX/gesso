import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { alignTo, blendWeights, stackMasks, type Rgba } from "../src/index.js";

/** A textured test scene (shapes and gradients), shifted by [dx, dy] and optionally blurred. */
async function scene(dx = 0, dy = 0, blur = 0, scale = 1): Promise<Rgba> {
  const svg = `<svg width="320" height="240" xmlns="http://www.w3.org/2000/svg"><rect width="320" height="240" fill="#6E8FB0"/>
    <g transform="translate(${160 + dx} ${120 + dy}) scale(${scale}) translate(-160 -120)">
    <circle cx="90" cy="80" r="40" fill="#E8471A"/><rect x="170" y="60" width="90" height="120" fill="#F2E3C9"/>
    <path d="M 20 220 L 120 140 L 200 220 Z" fill="#2B4A2F"/><circle cx="250" cy="200" r="18" fill="#141414"/>
    ${Array.from({ length: 30 }, (_, i) => `<rect x="${(i * 37) % 300}" y="${(i * 53) % 220}" width="6" height="6" fill="#${i % 2 ? "FFFFFF" : "000000"}"/>`).join("")}</g></svg>`;
  let img = sharp(Buffer.from(svg));
  if (blur) img = img.blur(blur);
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, pixels: new Uint8Array(data) };
}

describe("auto-align", () => {
  it("finds the shift that lines a frame up with the reference", async () => {
    const [ref, moved] = await Promise.all([scene(), scene(7, -4)]);
    const a = alignTo(ref, moved);
    expect(a.dx).toBeCloseTo(-7, 0);
    expect(a.dy).toBeCloseTo(4, 0);
    expect(a.scale).toBe(1);
  });

  it("finds focus breathing (scale) when asked", async () => {
    const [ref, zoomed] = await Promise.all([scene(), scene(0, 0, 0, 1.03)]);
    const a = alignTo(ref, zoomed, { scale: true });
    expect(a.scale).toBeCloseTo(1 / 1.03, 1);
    expect(Math.abs(a.dx) + Math.abs(a.dy)).toBeLessThan(2);
  });
});

describe("auto-blend", () => {
  it("weights each pixel towards the frame that's sharp there", async () => {
    // Frame A is sharp on the left half, frame B on the right.
    const [sharpImg, soft] = await Promise.all([scene(), scene(0, 0, 4)]);
    const half = (left: Rgba, right: Rgba): Rgba => {
      const pixels = new Uint8Array(left.pixels.length);
      for (let y = 0; y < left.height; y++) for (let x = 0; x < left.width; x++) {
        const i = (y * left.width + x) * 4;
        pixels.set((x < left.width / 2 ? left : right).pixels.subarray(i, i + 4), i);
      }
      return { ...left, pixels };
    };
    const a = half(sharpImg, soft);
    const b = half(soft, sharpImg);
    const [wa, wb] = blendWeights([a, b], "focus", 8);
    // On edges, where focus decides: the circle's left edge (left half) and the card's left edge (right half).
    const at = (x: number, y: number) => y * 320 + x;
    expect(wa![at(50, 80)]).toBeGreaterThan(0.8);
    expect(wb![at(170, 100)]).toBeGreaterThan(0.8);
    expect(wa![at(50, 80)]! + wb![at(50, 80)]!).toBeCloseTo(1, 5);
    const [bottom, top] = stackMasks([wa!, wb!]);
    expect(bottom![at(50, 80)]).toBe(255);
    expect(top![at(170, 100)]).toBeGreaterThan(200);
    expect(top![at(50, 80)]).toBeLessThan(55);
  });

  it("favours well-exposed frames in exposure fusion", async () => {
    const base = await scene();
    const shade = (k: number): Rgba => ({ ...base, pixels: base.pixels.map((v, i) => (i % 4 === 3 ? v : Math.min(255, Math.round(v * k)))) });
    const [dark, mid, bright] = blendWeights([shade(0.25), shade(1), shade(3)], "exposure", 8);
    const i = 120 * 320 + 160;
    expect(mid![i]).toBeGreaterThan(dark![i]!);
    expect(mid![i]).toBeGreaterThan(bright![i]!);
  });
});
