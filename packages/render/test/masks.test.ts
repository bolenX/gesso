import type { Doc, Layer } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderArtboard, writeSvg } from "../src/index.js";

const px = (pixels: Uint8Array, x: number, y: number, w = 20) => Array.from(pixels.slice((y * w + x) * 4, (y * w + x) * 4 + 3));
const rect = (id: string, fill: string, frame: Layer["frame"], extra: object = {}) => ({ id, name: id, type: "shape", shape: { kind: "rect" }, fill, frame, ...extra }) as Layer;

/** Left half black, right half white, with a red layer over everything that takes `extra`. */
const split = (extra: object, more: Layer[] = []): Doc => ({
  id: "m",
  revision: 0,
  assets: {},
  artboards: [
    {
      id: "a",
      name: "A",
      frame: { x: 0, y: 0, w: 20, h: 10 },
      layers: [rect("dark", "#000000", { x: 0, y: 0, w: 10, h: 10 }), rect("light", "#FFFFFF", { x: 10, y: 0, w: 10, h: 10 }), ...more, rect("paint", "#FF0000", { x: 0, y: 0, w: 20, h: 10 }, extra)],
    },
  ],
});

describe("computed masks", () => {
  it("shows a layer only over the lights of what's below (luminosity mask)", async () => {
    const out = (await renderArtboard(split({ mask: { kind: "luminosity", range: "lights" } }), "a")).pixels;
    expect(px(out, 15, 5)).toEqual([255, 0, 0]);
    expect(px(out, 5, 5)).toEqual([0, 0, 0]);
    const darks = (await renderArtboard(split({ mask: { kind: "luminosity", range: "darks" } }), "a")).pixels;
    expect(px(darks, 5, 5)).toEqual([255, 0, 0]);
    expect(px(darks, 15, 5)).toEqual([255, 255, 255]);
  });

  it("selects by colour (color range) from a named layer", async () => {
    const swatch = rect("swatch", "#2040C0", { x: 0, y: 0, w: 10, h: 10 }, { visible: false });
    const doc = split({ mask: { kind: "color-range", source: "swatch", color: "#2040C0", fuzziness: 40 } }, [swatch]);
    const out = (await renderArtboard(doc, "a")).pixels;
    expect(px(out, 5, 5)).toEqual([255, 0, 0]);
    expect(px(out, 15, 5)).toEqual([255, 255, 255]);
  });

  it("uses a channel with levels, inverted", async () => {
    // The green channel is 0 on the left and 255 on the right; inverted, the left shows.
    const out = (await renderArtboard(split({ mask: { kind: "channel", channel: "green", invert: true } }), "a")).pixels;
    expect(px(out, 5, 5)).toEqual([255, 0, 0]);
    expect(px(out, 15, 5)).toEqual([255, 255, 255]);
  });
});

describe("Blend If", () => {
  it("hides the layer where what's below is brighter than the range", async () => {
    const out = (await renderArtboard(split({ blendIf: { underlying: [0, 0, 100, 100] } }), "a")).pixels;
    expect(px(out, 5, 5)).toEqual([255, 0, 0]);
    expect(px(out, 15, 5)).toEqual([255, 255, 255]);
  });

  it("fades across split sliders", async () => {
    // A mid-grey backdrop (128) halfway between the white split (100) and white (156) shows half the layer.
    const doc = split({ blendIf: { underlying: [0, 0, 100, 156] } }, [rect("grey", "#808080", { x: 0, y: 0, w: 20, h: 10 })]);
    const [r] = px((await renderArtboard(doc, "a")).pixels, 5, 5);
    expect(Math.abs(r! - (128 + 255) / 2)).toBeLessThanOrEqual(3);
  });

  it("tests the layer's own pixels with 'this'", async () => {
    const out = (await renderArtboard(split({ blendIf: { channel: "red", this: [0, 0, 200, 200] } }), "a")).pixels;
    // The layer is pure red (255): above 200 in red, so it's hidden everywhere.
    expect(px(out, 5, 5)).toEqual([0, 0, 0]);
  });

  it("flattens backdrop-reading layers in SVG", async () => {
    const { warnings } = await writeSvg(split({ blendIf: { underlying: [0, 0, 100, 100] } }), "a");
    expect(warnings.join(" ")).toMatch(/flattened/);
  });
});

describe("pass-through groups with a mask", () => {
  it("lets the layers inside blend with what's below, then masks the result (Photoshop's pass-through)", async () => {
    // Grey below; inside a group masked to the left half, a red Multiply copy and an opacity-50% group.
    const doc: Doc = {
      id: "g",
      revision: 0,
      assets: {},
      artboards: [
        {
          id: "a",
          name: "A",
          frame: { x: 0, y: 0, w: 20, h: 10 },
          background: "#808080",
          layers: [
            {
              id: "grp",
              name: "grp",
              type: "group",
              frame: { x: 0, y: 0, w: 20, h: 10 },
              mask: { kind: "vector", shape: { kind: "rect" }, frame: { x: 0, y: 0, w: 10, h: 10 } },
              children: [rect("red", "#FF0000", { x: 0, y: 0, w: 20, h: 10 }, { blend: "multiply" })],
            } as Layer,
          ],
        },
      ],
    };
    const out = (await renderArtboard(doc, "a")).pixels;
    // Inside: red multiplied with the grey below (not red on its own, as an isolated group would give).
    expect(px(out, 3, 5)).toEqual([128, 0, 0]);
    // Outside the mask: the grey untouched.
    expect(px(out, 15, 5)).toEqual([128, 128, 128]);
    // Opacity alone fades between the two.
    const faded = (await renderArtboard({ ...doc, artboards: [{ ...doc.artboards[0]!, layers: [{ ...(doc.artboards[0]!.layers[0] as object), mask: undefined, opacity: 0.5 } as Layer] }] }, "a")).pixels;
    px(faded, 15, 5).forEach((v, c) => expect(Math.abs(v - [128, 64, 64][c]!)).toBeLessThanOrEqual(1));
  });
});

describe("compound shapes", () => {
  const ring = (op: "add" | "subtract" | "intersect" | "exclude"): Doc => ({
    id: "c",
    revision: 0,
    assets: {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 20, h: 10 },
        background: "#FFFFFF",
        layers: [
          {
            id: "s",
            name: "s",
            type: "shape",
            fill: "#000000",
            frame: { x: 0, y: 0, w: 20, h: 10 },
            shape: { kind: "compound", parts: [{ shape: { kind: "rect" }, frame: { x: 0, y: 0, w: 14, h: 10 } }, { shape: { kind: "rect" }, frame: { x: 6, y: 0, w: 14, h: 10 }, op }] },
          } as Layer,
        ],
      },
    ],
  });
  // Two overlapping bars, 0..14 and 6..20: probe the left-only, overlap and right-only parts.
  const probe = async (op: "add" | "subtract" | "intersect" | "exclude") => {
    const out = (await renderArtboard(ring(op), "a")).pixels;
    return [px(out, 2, 5)[0], px(out, 10, 5)[0], px(out, 17, 5)[0]];
  };
  it("adds, subtracts, intersects and excludes", async () => {
    expect(await probe("add")).toEqual([0, 0, 0]);
    expect(await probe("subtract")).toEqual([0, 255, 255]);
    expect(await probe("intersect")).toEqual([255, 0, 255]);
    expect(await probe("exclude")).toEqual([0, 255, 0]);
  });

  it("writes the combined outline as an SVG path", async () => {
    const { svg } = await writeSvg(ring("subtract"), "a");
    expect(svg).toMatch(/<path d="M0 0L6 0L6 10L0 10L0 0Z"|<path d="M[^"]+" fill="#000000"/);
    expect(svg).not.toMatch(/<image/);
  });
});

describe("transforms", () => {
  const square = (extra: object): Doc => ({
    id: "t",
    revision: 0,
    assets: {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 20, h: 10 },
        background: "#FFFFFF",
        layers: [{ id: "s", name: "s", type: "shape", shape: { kind: "rect" }, fill: "#000000", frame: { x: 5, y: 0, w: 10, h: 10 }, ...extra } as Layer],
      },
    ],
  });
  const ink = async (extra: object) => {
    const out = (await renderArtboard(square(extra), "a")).pixels;
    return (x: number, y: number) => px(out, x, y)[0]!;
  };

  it("skews around the centre", async () => {
    // 45° horizontal skew: the top row shifts left and the bottom row right by half the height.
    const at = await ink({ skew: [45, 0] });
    expect(at(2, 1)).toBeLessThan(60);
    expect(at(17, 1)).toBeGreaterThan(200);
    expect(at(17, 8)).toBeLessThan(60);
    expect(at(2, 8)).toBeGreaterThan(200);
  });

  it("pins corners with a quad (distort / perspective)", async () => {
    const at = await ink({ quad: [[0, 0], [20, 0], [12, 10], [8, 10]] });
    expect(at(3, 1)).toBeLessThan(60);
    expect(at(17, 1)).toBeLessThan(60);
    expect(at(2, 9)).toBeGreaterThan(200);
    expect(at(10, 9)).toBeLessThan(60);
  });

  it("leaves a layer unchanged under an even warp grid and bends it under a moved one", async () => {
    const even = [[[0, 0], [0.5, 0], [1, 0]], [[0, 0.5], [0.5, 0.5], [1, 0.5]], [[0, 1], [0.5, 1], [1, 1]]];
    const plain = (await renderArtboard(square({}), "a")).pixels;
    const flat = (await renderArtboard(square({ warp: even }), "a")).pixels;
    let diff = 0;
    for (let i = 0; i < plain.length; i++) diff += Math.abs(plain[i]! - flat[i]!);
    expect(diff / plain.length).toBeLessThan(2);
    const bulge = structuredClone(even);
    bulge[1]![2] = [1.8, 0.5];
    const at = await ink({ warp: bulge });
    expect(at(17, 5)).toBeLessThan(60);
    expect(at(17, 0)).toBeGreaterThan(200);
  });
});

describe("refine edge, calculations and stroked masks", () => {
  // A dark subject with thin dark strands reaching out into a light background, like hair against sky.
  const hair = async () => {
    const strands = Array.from({ length: 8 }, (_, i) => `<line x1="${30 + i * 5}" y1="30" x2="${20 + i * 8}" y2="4" stroke="#201810" stroke-width="2"/>`).join("");
    const svg = `<svg width="100" height="80" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="80" fill="#9CC8F0"/><ellipse cx="50" cy="55" rx="30" ry="25" fill="#201810"/>${strands}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  };
  const doc = (mask: object): Doc => ({
    id: "r",
    revision: 0,
    assets: { photo: { uri: "photo", kind: "image" } },
    artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 100, h: 80 }, background: "#FF00FF", layers: [{ id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: 100, h: 80 }, mask } as Layer] }],
  });

  it("refines a rough mask to take in fine strands and leave the background out", async () => {
    const png = await hair();
    const loader = async () => png;
    const rough = { kind: "vector", shape: { kind: "ellipse" }, frame: { x: 20, y: 30, w: 60, h: 50 }, feather: 6 };
    const before = (await renderArtboard(doc(rough), "a", { loader })).pixels;
    const after = (await renderArtboard(doc({ ...rough, refine: { radius: 12 } }), "a", { loader })).pixels;
    // On the fourth strand, outside the rough mask: masked out before, coming through after (matting.test.ts
    // measures how close to the truth).
    const strand = (p: Uint8Array) => px(p, 45, 22, 100);
    expect(strand(before)[0]).toBeGreaterThan(180);
    expect(strand(after)[0]).toBeLessThan(strand(before)[0]! - 60);
    // Sky between strands, near the subject, stays out (magenta shows through).
    expect(px(after, 90, 20, 100)).toEqual([255, 0, 255]);
    // The solid body is fully in.
    expect(px(after, 50, 60, 100)).toEqual(px(before, 50, 60, 100));
  });

  it("decontaminates edge colours towards the subject's own", async () => {
    // A red disc whose soft edge is mixed with the green background.
    const svg = `<svg width="60" height="60" xmlns="http://www.w3.org/2000/svg"><rect width="60" height="60" fill="#20C020"/><circle cx="30" cy="30" r="18" fill="#C02020"/></svg>`;
    const png = await sharp(Buffer.from(svg)).blur(2).png().toBuffer();
    const make = (decontaminate?: number): Doc => ({
      id: "d",
      revision: 0,
      assets: { photo: { uri: "photo", kind: "image" } },
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 60, h: 60 }, background: "#FFFFFF", layers: [{ id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: 60, h: 60 }, mask: { kind: "color-range", source: "p", color: "#C02020", fuzziness: 120, refine: { radius: 4, ...(decontaminate ? { decontaminate } : {}) } } } as Layer] }],
    });
    const loader = async () => png;
    const [plain, clean] = await Promise.all([renderArtboard(make(), "a", { loader }), renderArtboard(make(100), "a", { loader })]);
    // On the soft edge, the green fringe falls once decontaminated.
    const greenness = (p: Uint8Array) => {
      let g = 0;
      for (let x = 8; x < 14; x++) g += px(p, x, 30, 60)[1]! - px(p, x, 30, 60)[0]!;
      return g;
    };
    expect(greenness(clean.pixels)).toBeLessThan(greenness(plain.pixels) - 20);
  });

  it("blends two channels into a mask with Calculations", async () => {
    const png = await sharp({ create: { width: 20, height: 10, channels: 3, background: "#000000" } })
      .composite([{ input: Buffer.from('<svg width="20" height="10"><rect width="10" height="10" fill="#4080FF"/><rect x="10" width="10" height="10" fill="#FF8040"/></svg>'), left: 0, top: 0 }])
      .png()
      .toBuffer();
    const calc = { kind: "calculations", a: { source: "p", channel: "blue" }, b: { source: "p", channel: "blue" }, blend: "multiply" };
    const out = (await renderArtboard({ ...doc(calc), assets: { photo: { uri: "photo", kind: "image" } }, artboards: [{ ...doc(calc).artboards[0]!, frame: { x: 0, y: 0, w: 20, h: 10 }, layers: [{ ...doc(calc).artboards[0]!.layers[0]!, frame: { x: 0, y: 0, w: 20, h: 10 } } as Layer] }] }, "a", { loader: async () => png })).pixels;
    // Blue × blue: the blue half stays (255·255/255), the orange half (blue 64) nearly vanishes into magenta.
    const at = (x: number) => [out[(5 * 20 + x) * 4]!, out[(5 * 20 + x) * 4 + 1]!, out[(5 * 20 + x) * 4 + 2]!];
    expect(at(4)).toEqual([64, 128, 255]);
    expect(at(15)[1]).toBeLessThan(20);
  });

  it("strokes a vector mask along a path like a brush", async () => {
    const solid = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#000000" } }).png().toBuffer();
    const stroked: Doc = {
      id: "s",
      revision: 0,
      assets: { photo: { uri: "photo", kind: "image" } },
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 40, h: 20 }, background: "#FFFFFF", layers: [{ id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: 40, h: 20 }, mask: { kind: "vector", shape: { kind: "path", d: "M 5 10 L 35 10" }, stroke: 6 } } as Layer] }],
    };
    const out = (await renderArtboard(stroked, "a", { loader: async () => solid })).pixels;
    expect(px(out, 20, 10, 40)).toEqual([0, 0, 0]);
    expect(px(out, 20, 2, 40)).toEqual([255, 255, 255]);
    // Round caps reach past the ends.
    expect(px(out, 3, 10, 40)[0]).toBeLessThan(128);
  });
});
