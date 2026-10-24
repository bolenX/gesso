import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Doc, Layer } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encode, renderArtboard, type AssetLoader } from "../src/index.js";

// Reference renders. Each scene renders and compares with test/golden/<name>.png; a change
// in the output beyond rounding fails. After an intended change, regenerate with
//   UPDATE_GOLDEN=1 pnpm test
// and look at the new images before committing them.

const here = dirname(fileURLToPath(import.meta.url));
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const hasFont = existsSync(FONT);

const rect = (id: string, fill: Layer extends never ? never : unknown, frame: { x: number; y: number; w: number; h: number }, extra: object = {}) =>
  ({ id, name: id, type: "shape", shape: { kind: "rect" }, fill, frame, ...extra }) as Layer;

async function photo(): Promise<Uint8Array> {
  const svg = `<svg width="160" height="120" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2440E6"/><stop offset="1" stop-color="#FF4F1A"/></linearGradient></defs>
    <rect width="160" height="120" fill="url(#g)"/><circle cx="80" cy="60" r="34" fill="#FFC21A"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const scenes: Record<string, Layer[]> = {
  shapes: [
    rect("bg", { kind: "linear-gradient", angle: 45, stops: [{ offset: 0, color: "#F3EDE4" }, { offset: 1, color: "#2440E6" }] }, { x: 0, y: 0, w: 200, h: 150 }),
    { id: "ring", name: "ring", type: "shape", shape: { kind: "ellipse" }, stroke: { paint: "#111110", width: 6 }, frame: { x: 20, y: 20, w: 70, h: 70 } } as Layer,
    { id: "star", name: "star", type: "shape", shape: { kind: "path", d: "M 30 0 L 38 22 L 60 22 L 42 36 L 49 58 L 30 44 L 11 58 L 18 36 L 0 22 L 22 22 Z" }, fill: "#FF4F1A", frame: { x: 110, y: 20, w: 60, h: 58 } } as Layer,
    rect("pill", { kind: "radial-gradient", stops: [{ offset: 0, color: "#FFC21A" }, { offset: 1, color: "#FF4F1A" }] }, { x: 20, y: 100, w: 160, h: 36 }, { shape: { kind: "rect", radius: 18 } }),
  ],
  blending: [
    { id: "photo", name: "photo", type: "image", asset: "photo", fit: "cover", frame: { x: 0, y: 0, w: 200, h: 150 } } as Layer,
    ...(["multiply", "screen", "overlay", "difference", "color", "luminosity"] as const).map((blend, i) =>
      rect(`b-${blend}`, "#2D9C6A", { x: 10 + (i % 3) * 63, y: 15 + Math.floor(i / 3) * 65, w: 55, h: 55 }, { blend }),
    ),
  ],
  "effects-and-transforms": [
    rect("bg", "#F3EDE4", { x: 0, y: 0, w: 200, h: 150 }),
    rect("card", "#FFFFFF", { x: 20, y: 20, w: 70, h: 70 }, { shape: { kind: "rect", radius: 10 }, effects: [{ kind: "drop-shadow", distance: 6, size: 12, opacity: 0.5 }] }),
    rect("turned", "#2440E6", { x: 110, y: 40, w: 70, h: 30 }, { rotation: 30, effects: [{ kind: "stroke", color: "#FFC21A", width: 3 }] }),
    {
      id: "masked", name: "masked", type: "image", asset: "photo", fit: "cover", frame: { x: 20, y: 100, w: 160, h: 40 },
      mask: { kind: "vector", shape: { kind: "rect", radius: 20 }, feather: 4 }, flip: "horizontal",
    } as Layer,
  ],
  adjustments: [
    { id: "photo", name: "photo", type: "image", asset: "photo", fit: "cover", frame: { x: 0, y: 0, w: 200, h: 150 } } as Layer,
    { id: "warm", name: "warm", type: "adjustment", adjustment: { kind: "hue-saturation", hue: 25, saturation: -40, lightness: 0 }, frame: { x: 0, y: 0, w: 200, h: 150 } } as Layer,
    { id: "curve", name: "curve", type: "adjustment", adjustment: { kind: "curves", points: [[0, 30], [128, 150], [255, 235]] }, frame: { x: 0, y: 0, w: 200, h: 150 } } as Layer,
  ],
  ...(hasFont
    ? {
        text: [
          rect("bg", "#111110", { x: 0, y: 0, w: 200, h: 150 }),
          {
            id: "head", name: "head", type: "text", content: "Gesso renders type", style: { font: "Bold", size: 26, fill: "#FFFFFF", align: "center" },
            runs: [{ text: "Gesso", fill: "#FF4F1A" }, { text: " renders type" }], frame: { x: 10, y: 15, w: 180, h: 70 },
          } as Layer,
          { id: "fit", name: "fit", type: "text", content: "Shrinks to fit its box", style: { font: "Bold", size: 40, fill: "#FFC21A" }, box: { kind: "area", shrinkToFit: true }, frame: { x: 10, y: 100, w: 180, h: 30 } } as Layer,
        ],
      }
    : {}),
};

function docFor(layers: Layer[]): Doc {
  return {
    id: "golden",
    revision: 0,
    assets: { photo: { uri: "photo.png", kind: "image" }, ...(hasFont ? { bold: { uri: FONT, kind: "font" as const, family: "Bold" } } : {}) },
    artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 200, h: 150 }, background: "#FFFFFF", layers }],
  };
}

describe("golden renders", async () => {
  const files: Record<string, Uint8Array> = { "photo.png": await photo() };
  const loader: AssetLoader = async ({ uri }) => files[uri] ?? readFile(uri);
  for (const [name, layers] of Object.entries(scenes)) {
    it(name, async () => {
      const out = await renderArtboard(docFor(layers), "a", { loader });
      const file = join(here, "golden", `${name}.png`);
      if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, await encode(out, "png"));
        return;
      }
      const { data } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let total = 0;
      let off = 0;
      for (let i = 0; i < data.length; i++) {
        const d = Math.abs(data[i]! - out.pixels[i]!);
        total += d;
        if (d > 16) off++;
      }
      // Rounding differs a little across platforms; real changes move far more.
      expect(total / data.length, `mean difference for ${name}`).toBeLessThan(0.5);
      expect(off / data.length, `share of clearly changed values for ${name}`).toBeLessThan(0.002);
    });
  }
});
