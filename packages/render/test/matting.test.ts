import type { Doc, Layer } from "@gesso/core";
import { Doc as DocSchema } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { matteMap, matteReport, renderArtboard } from "../src/index.js";
import { chokeMask, refineMask } from "../src/masks.js";
import { BG, colourLine, distanceTransform, estimateForeground, FG, fillHoles, makeTrimap, matte, planesOf, solveMatte, UNKNOWN } from "../src/matting.js";

// Hair with known opacity: strands and a solid head over a textured sky, composited exactly, so every estimate
// can be measured against the truth.
const W = 200;
const H = 150;
const hairColour = (x: number, y: number) => [0.36 + 0.05 * Math.sin(x / 9), 0.22 + 0.03 * Math.sin(y / 7), 0.12];
const skyColour = (x: number, y: number) => {
  const cloud = 0.5 + 0.5 * Math.sin(x / 23 + Math.sin(y / 17) * 2) * Math.cos(y / 19);
  return [0.55 + 0.3 * cloud, 0.72 + 0.2 * cloud, 0.95];
};

async function hairScene() {
  const strands = Array.from({ length: 30 }, (_, i) => {
    const t = Math.PI * (0.12 + (0.76 * i) / 29);
    const [sx, sy] = [100 - Math.cos(t) * 52, 108 - Math.sin(t) * 42];
    const len = 18 + ((i * 37) % 22);
    const [ex, ey] = [sx - Math.cos(t) * len + ((i * 13) % 11) - 5, sy - Math.sin(t) * len];
    return `<path d="M${sx},${sy} Q${(sx + ex) / 2 + ((i * 7) % 9) - 4},${(sy + ey) / 2} ${ex},${ey}" stroke="white" stroke-width="${0.8 + (i % 3) * 0.5}" fill="none"/>`;
  }).join("");
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="black"/><ellipse cx="100" cy="108" rx="55" ry="45" fill="white"/>${strands}</svg>`;
  const raw = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer();
  const n = W * H;
  const alpha = Float64Array.from(raw, (v) => v / 255);
  const rgba = new Uint8Array(n * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const [F, B, a] = [hairColour(x, y), skyColour(x, y), alpha[i]!];
      for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.round(255 * (a * F[c]! + (1 - a) * B[c]!));
      rgba[i * 4 + 3] = 255;
    }
  }
  // A rough mask like a quick segmentation's: the truth thresholded, with a slightly soft edge.
  const rough = await sharp(Buffer.from(Uint8Array.from(alpha, (a) => (a > 0.5 ? 255 : 0))), { raw: { width: W, height: H, channels: 1 } }).blur(1.5).extractChannel(0).raw().toBuffer();
  return { alpha, rgba, rough: new Uint8Array(rough) };
}

/** Mean squared error of an opacity against the truth, within `radius` of the rough mask's edge. */
function bandError(truth: Float64Array, got: ArrayLike<number>, scale: number, rough: Uint8Array, radius: number) {
  const inside = Uint8Array.from(rough, (v) => (v >= 128 ? 1 : 0));
  const toOut = distanceTransform(Uint8Array.from(inside, (v) => 1 - v), W, H);
  const toIn = distanceTransform(inside, W, H);
  let [sq, k] = [0, 0];
  for (let i = 0; i < W * H; i++) {
    if ((inside[i] ? toOut[i]! : toIn[i]!) > radius) continue;
    sq += (got[i]! / scale - truth[i]!) ** 2;
    k++;
  }
  return sq / k;
}

describe("matting", () => {
  it("solves opacity exactly when the trimap is right (closed-form matting)", async () => {
    const { alpha, rgba } = await hairScene();
    const n = W * H;
    const mixed = Uint8Array.from(alpha, (a) => (a > 0.004 && a < 0.996 ? 1 : 0));
    const near = distanceTransform(mixed, W, H);
    const tri = Uint8Array.from(alpha, (a, i) => (near[i]! <= 2 ? UNKNOWN : a > 0.5 ? FG : BG));
    const solved = solveMatte(planesOf(rgba, n), tri, new Float64Array(n).fill(0.5), W, H, { iterations: 600, tolerance: 1e-7 });
    let [sq, k] = [0, 0];
    for (let i = 0; i < n; i++) {
      if (tri[i] !== UNKNOWN) continue;
      sq += (solved[i]! - alpha[i]!) ** 2;
      k++;
    }
    expect(sq / k).toBeLessThan(0.002);
  });

  it("refines a rough mask to the hair's real opacity, far closer than the rough mask", async () => {
    const { alpha, rgba, rough } = await hairScene();
    const { coverage } = refineMask(rgba, rough, W, H, { radius: 8 });
    const before = bandError(alpha, rough, 255, rough, 8);
    const after = bandError(alpha, coverage, 255, rough, 8);
    expect(after).toBeLessThan(before / 4);
    expect(after).toBeLessThan(0.01);
  });

  it("solves big bands at a smaller size and brings back full detail with a fast guided filter", async () => {
    const { alpha, rgba, rough } = await hairScene();
    const n = W * H;
    const I = planesOf(rgba, n);
    const m = Float64Array.from(rough, (v) => v / 255);
    const estimate = colourLine(I, m, W, H, 16);
    const tri = makeTrimap(I, m, W, H, 8, false, estimate);
    const prior = { value: estimate, weight: estimate.confidence! };
    const direct = matte(I, tri, estimate, W, H, { prior });
    // A cap well under the band's size forces a solve at a third of the size.
    const halved = matte(I, tri, estimate, W, H, { prior, maxUnknown: 1500 });
    const before = bandError(alpha, rough, 255, rough, 8);
    expect(bandError(alpha, halved, 1, rough, 8)).toBeLessThan(before / 2);
    expect(bandError(alpha, halved, 1, rough, 8)).toBeLessThan(bandError(alpha, direct, 1, rough, 8) * 3);
  });

  it("recovers each strand's own colour when decontaminating", async () => {
    const { alpha, rgba, rough } = await hairScene();
    const colourError = (content: Uint8Array) => {
      let [e, k] = [0, 0];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (alpha[i]! < 0.15 || alpha[i]! > 0.85) continue;
          const F = hairColour(x, y);
          for (let c = 0; c < 3; c++) e += Math.abs(content[i * 4 + c]! / 255 - F[c]!);
          k++;
        }
      }
      return e / k / 3;
    };
    const { content } = refineMask(rgba, rough, W, H, { radius: 8, decontaminate: 100 });
    expect(colourError(content!)).toBeLessThan(colourError(rgba) * 0.6);
    // With the true opacity, the colour estimate itself is nearly exact.
    const F = estimateForeground(planesOf(rgba, W * H), alpha, W, H);
    const ideal = new Uint8Array(rgba);
    for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) ideal[i * 4 + c] = Math.round(F[c]![i]! * 255);
    expect(colourError(ideal)).toBeLessThan(0.03);
  });

  it("keeps the band narrow along clean edges with smart radius, and wide where there's hair", async () => {
    // Left half: a clean vertical edge. Right half: strands crossing it.
    const strands = Array.from({ length: 12 }, (_, i) => `<line x1="100" y1="${10 + i * 11}" x2="${130 + (i % 3) * 6}" y2="${4 + i * 11}" stroke="#201810" stroke-width="1.5"/>`).join("");
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#9CC8F0"/><rect x="0" width="100" height="${H}" fill="#201810"/>${strands}</svg>`;
    const rgba = new Uint8Array(await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer());
    const n = W * H;
    // The rough mask: left half in, with a vertical edge at x = 100 (clean) — the strands are on the right.
    const m = Float64Array.from({ length: n }, (_, i) => (i % W < 100 ? 1 : 0));
    const I = planesOf(rgba, n);
    const plain = makeTrimap(I, m, W, H, 16, false);
    const smart = makeTrimap(I, m, W, H, 16, true);
    // Counts the band outside the edge (x ≥ 100), where the strands are.
    const unknownIn = (tri: Uint8Array, rows: [number, number]) => {
      let k = 0;
      for (let y = rows[0]; y < rows[1]; y++) for (let x = 100; x < W; x++) if (tri[y * W + x] === UNKNOWN) k++;
      return k;
    };
    // Rows 140–150 have no strands: a clean edge, where smart radius keeps a quarter of the band.
    expect(unknownIn(smart, [140, 150])).toBeLessThan(unknownIn(plain, [140, 150]) / 2);
    // Where strands cross, it keeps the full band.
    expect(unknownIn(smart, [20, 60])).toBeGreaterThan(unknownIn(plain, [20, 60]) * 0.8);
  });
});

describe("keys", () => {
  const magenta = "#FF00FF";
  const photoDoc = (mask: object, extra: Layer[] = []): Doc =>
    DocSchema.parse({
      id: "k",
      revision: 0,
      assets: { photo: { uri: "photo", kind: "image" }, plate: { uri: "plate", kind: "image" } },
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: W, h: H }, background: magenta, layers: [...extra, { id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: W, h: H }, mask }] }],
    });
  const at = (p: Uint8Array, x: number, y: number) => Array.from(p.slice((y * W + x) * 4, (y * W + x) * 4 + 3));

  // A dark subject with strands on a studio backdrop that falls off from light grey to darker at the edges.
  const studio = async () => {
    const strands = Array.from({ length: 10 }, (_, i) => `<line x1="${70 + i * 6}" y1="70" x2="${60 + i * 9}" y2="25" stroke="#2A1E18" stroke-width="1.5"/>`).join("");
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><radialGradient id="g" cx="50%" cy="45%" r="70%"><stop offset="0" stop-color="#E8E8E6"/><stop offset="1" stop-color="#A8A8A6"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><ellipse cx="100" cy="105" rx="45" ry="40" fill="#2A1E18"/>${strands}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  };

  it("cuts a subject out of a studio backdrop, falloff and all", async () => {
    const png = await studio();
    const out = (await renderArtboard(photoDoc({ kind: "backdrop", refine: { radius: 6 } }), "a", { loader: async () => png })).pixels;
    // Backdrop gone everywhere, including the darker corners.
    for (const [x, y] of [[3, 3], [W - 4, H - 4], [100, 10], [180, 75]] as const) expect(at(out, x, y)).toEqual([255, 0, 255]);
    // The subject stays.
    expect(at(out, 100, 110)).toEqual([0x2a, 0x1e, 0x18]);
    // A strand comes through over the magenta: solid at its centre, and its soft edge (a fifth strand, four
    // fifths backdrop) at about a fifth opacity.
    expect(at(out, 87, 45)).toEqual([42, 30, 24]);
    const edge = at(out, 88, 45);
    expect(edge[1]).toBeGreaterThan(15);
    expect(edge[1]).toBeLessThan(70);
  });

  it("takes the backdrop colour when given, and inverts", async () => {
    const png = await studio();
    const render = async (invert: boolean) => (await renderArtboard(photoDoc({ kind: "backdrop", color: "#2A1E18", tolerance: 6, invert }), "a", { loader: async () => png })).pixels;
    // Keyed on the subject's dark colour, the subject goes and the light backdrop stays...
    const keyed = await render(false);
    expect(at(keyed, 100, 110)).toEqual([255, 0, 255]);
    expect(at(keyed, 10, 75)[1]).toBeGreaterThan(100);
    // ...and inverted, the other way round.
    const inverted = await render(true);
    expect(at(inverted, 100, 110)).toEqual([42, 30, 24]);
    expect(at(inverted, 10, 75)).toEqual([255, 0, 255]);
  });

  it("keys a subject against a clean plate of the same scene", async () => {
    const plateSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#6B8E5A"/><circle cx="40" cy="40" r="25" fill="#C8B070"/><rect x="120" y="90" width="60" height="50" fill="#5A4A3A"/></svg>`;
    const photoSvg = plateSvg.replace("</svg>", `<rect x="70" y="30" width="50" height="90" fill="#D04030"/></svg>`);
    const [plate, photo] = await Promise.all([sharp(Buffer.from(plateSvg)).png().toBuffer(), sharp(Buffer.from(photoSvg)).png().toBuffer()]);
    const doc = photoDoc({ kind: "difference", plate: "bg" }, [{ id: "bg", name: "plate", type: "image", asset: "plate", fit: "fill", visible: false, frame: { x: 0, y: 0, w: W, h: H } } as Layer]);
    const out = (await renderArtboard(doc, "a", { loader: async (asset) => (asset.uri === "plate" ? plate : photo) })).pixels;
    expect(at(out, 95, 75)).toEqual([0xd0, 0x40, 0x30]);
    // The busy background, matched by the plate, is gone.
    for (const [x, y] of [[40, 40], [150, 115], [10, 140]] as const) expect(at(out, x, y)).toEqual([255, 0, 255]);
  });
});

describe("cut-out checks", () => {
  // A red disc on transparency, with an anti-aliased edge; extras paint into it.
  const disc = (edgeColour?: [number, number, number]) => {
    const [w, h] = [80, 60];
    const pixels = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x + 0.5 - 40, y + 0.5 - 30);
        const a = Math.min(1, Math.max(0, 20.5 - d));
        const i = (y * w + x) * 4;
        const colour = a < 1 && edgeColour ? edgeColour : [200, 40, 30];
        pixels.set([...colour, Math.round(a * 255)], i);
      }
    }
    return { artboard: "a", width: w, height: h, pixels, warnings: [] };
  };

  it("passes a clean hard edge", () => {
    const report = matteReport(disc());
    expect(report.edgeWidth).toBeLessThan(1.5);
    expect(report.halo).toBeLessThan(3);
    expect(report).toMatchObject({ haloTone: "none", specks: 0, holes: 0 });
    // π·20² of 80×60.
    expect(report.solid).toBeCloseTo(25, -1);
  });

  it("finds a light fringe of old background, specks and a hole", () => {
    const r = disc([235, 235, 235]);
    const w = r.width;
    // A speck of background left behind, and a pocket keyed out inside.
    r.pixels.set([200, 40, 30, 255], (5 * w + 5) * 4);
    for (let y = 26; y < 31; y++) for (let x = 36; x < 41; x++) r.pixels[(y * w + x) * 4 + 3] = 0;
    const report = matteReport(r);
    expect(report.halo).toBeGreaterThan(20);
    expect(report.haloTone).toBe("lighter");
    expect(report.specks).toBe(1);
    expect(report.holes).toBe(1);
    expect(report.holeArea).toBeGreaterThan(1);
  });

  it("shows the cut-out as a mask and over black, white and red", () => {
    const map = matteMap(disc(), 4);
    expect([map.width, map.height]).toEqual([164, 124]);
    const at = (x: number, y: number) => Array.from(map.pixels.slice((y * map.width + x) * 4, (y * map.width + x) * 4 + 3));
    expect(at(40, 30)).toEqual([255, 255, 255]);
    expect(at(1, 1)).toEqual([0, 0, 0]);
    expect(at(84 + 1, 1)).toEqual([0, 0, 0]);
    expect(at(1, 64 + 1)).toEqual([255, 255, 255]);
    expect(at(84 + 1, 64 + 1)).toEqual([255, 0, 0]);
    expect(at(84 + 40, 64 + 30)).toEqual([200, 40, 30]);
  });

  it("measures less halo once the edge is decontaminated", async () => {
    // A dark subject with strands on a light backdrop, cut out with a backdrop key.
    const strands = Array.from({ length: 10 }, (_, i) => `<line x1="${70 + i * 6}" y1="70" x2="${60 + i * 9}" y2="25" stroke="#2A1E18" stroke-width="1.5"/>`).join("");
    const png = await sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#E4E4E2"/><ellipse cx="100" cy="105" rx="45" ry="40" fill="#2A1E18"/>${strands}</svg>`)).png().toBuffer();
    const cut = async (refine: object) =>
      matteReport(
        await renderArtboard(
          DocSchema.parse({ id: "c", revision: 0, assets: { photo: { uri: "photo", kind: "image" } }, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: W, h: H }, layers: [{ id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: W, h: H }, mask: { kind: "backdrop", refine } }] }] }),
          "a",
          { loader: async () => png },
        ),
      );
    const [plain, clean] = await Promise.all([cut({ radius: 6 }), cut({ radius: 6, decontaminate: 100 })]);
    expect(plain.haloTone).toBe("lighter");
    expect(clean.halo).toBeLessThan(plain.halo / 2);
  });
});

describe("choke, spread and holes", () => {
  // Brute force: the extreme over every pixel within the window, edges repeating.
  const naive = (m: Uint8Array, w: number, h: number, amount: number, square: boolean) => {
    const r = Math.abs(amount);
    const R = Math.floor(r);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = amount > 0 ? 255 : 0;
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            if (!square && dx * dx + dy * dy > r * r) continue;
            const q = m[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]!;
            v = amount > 0 ? Math.min(v, q) : Math.max(v, q);
          }
        }
        out[y * w + x] = v;
      }
    }
    return out;
  };

  it("chokes and spreads a mask exactly like Minimum and Maximum, round or square", () => {
    const [w, h] = [37, 29];
    const m = Uint8Array.from({ length: w * h }, (_, i) => ((i * 7919) % 97 < 60 ? 255 : (i * 31) % 256));
    for (const amount of [1, 2.5, 4, -1, -3.2]) {
      for (const square of [false, true]) expect(Array.from(chokeMask(m, w, h, amount, square))).toEqual(Array.from(naive(m, w, h, amount, square)));
    }
  });

  it("removes a halo by choking the cut-out's mask", async () => {
    // A dark disc whose rough mask runs 3 px too wide, taking in a ring of the white backdrop.
    const png = await sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#FFFFFF"/><circle cx="100" cy="75" r="40" fill="#203040"/></svg>`)).png().toBuffer();
    const render = (choke?: number) =>
      renderArtboard(
        DocSchema.parse({ id: "h", revision: 0, assets: { photo: { uri: "photo", kind: "image" } }, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: W, h: H }, background: "#000000", layers: [{ id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: W, h: H }, mask: { kind: "vector", shape: { kind: "ellipse" }, frame: { x: 57, y: 32, w: 86, h: 86 }, ...(choke ? { choke } : {}) } }] }] }),
        "a",
        { loader: async () => png },
      );
    const [halo, clean] = await Promise.all([render(), render(3)]);
    const rim = (p: Uint8Array) => p[(75 * W + 141) * 4]!;
    // At 1 px inside the rough edge: white backdrop before, the black background once choked.
    expect(rim(halo.pixels)).toBeGreaterThan(200);
    expect(rim(clean.pixels)).toBeLessThan(20);
    // The disc itself is untouched.
    expect(clean.pixels[(75 * W + 100) * 4]).toBe(0x20);
  });

  it("fills see-through pockets, so a key on glass gives its silhouette", async () => {
    const [w, h] = [9, 7];
    const ring = Float64Array.from({ length: w * h }, (_, i) => {
      const [x, y] = [i % w, Math.floor(i / w)];
      return x >= 2 && x <= 6 && y >= 1 && y <= 5 && (x === 2 || x === 6 || y === 1 || y === 5) ? 1 : 0;
    });
    const filled = fillHoles(ring, w, h);
    expect(filled[3 * w + 4]).toBe(1);
    expect(filled[0]).toBe(0);
    // Through the renderer: a clear bottle on a grey backdrop, its body showing the backdrop through it.
    const png = await sharp(Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><rect width="${W}" height="${H}" fill="#C8C8C8"/><rect x="80" y="20" width="40" height="110" rx="12" fill="#C8C8C8" stroke="#3A4A40" stroke-width="5"/></svg>`)).png().toBuffer();
    const key = (fill: boolean) =>
      renderArtboard(
        DocSchema.parse({ id: "f", revision: 0, assets: { photo: { uri: "photo", kind: "image" } }, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: W, h: H }, background: "#FF00FF", layers: [{ id: "p", name: "p", type: "image", asset: "photo", fit: "fill", frame: { x: 0, y: 0, w: W, h: H }, mask: { kind: "backdrop", ...(fill ? { fillHoles: true } : {}) } }] }] }),
        "a",
        { loader: async () => png },
      );
    const [open, filledKey] = await Promise.all([key(false), key(true)]);
    const centre = (p: Uint8Array) => Array.from(p.slice((75 * W + 100) * 4, (75 * W + 100) * 4 + 3));
    expect(centre(open.pixels)).toEqual([255, 0, 255]);
    expect(centre(filledKey.pixels)).toEqual([200, 200, 200]);
    // Outside the bottle, the backdrop is still keyed out.
    expect(Array.from(filledKey.pixels.slice((75 * W + 30) * 4, (75 * W + 30) * 4 + 3))).toEqual([255, 0, 255]);
  });
});
