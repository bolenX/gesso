import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Doc } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { writeSvg } from "../src/index.js";

const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

async function sample(): Promise<{ doc: Doc; loader: (a: { uri: string }) => Promise<Uint8Array> }> {
  const photo = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#2440E6" } }).jpeg().toBuffer();
  const doc: Doc = {
    id: "svg",
    revision: 2,
    assets: { photo: { uri: "photo.jpg", kind: "image" }, ...(existsSync(FONT) ? { b: { uri: FONT, kind: "font" as const, family: "Bold" } } : {}) },
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 200, h: 100 },
        background: "#FFFFFF",
        layers: [
          { id: "photo", name: "Photo", type: "image", asset: "photo", fit: "cover", frame: { x: 0, y: 0, w: 80, h: 80 }, mask: { kind: "vector", shape: { kind: "ellipse" }, invert: true } },
          { id: "card", name: "Card & co", type: "shape", shape: { kind: "rect", radius: 8 }, fill: { kind: "linear-gradient", angle: 0, stops: [{ offset: 0, color: "#FF4F1A" }, { offset: 1, color: "#FFC21A80" }] }, frame: { x: 100, y: 10, w: 80, h: 40 }, rotation: 10, blend: "multiply" },
          { id: "soft", name: "Soft", type: "shape", shape: { kind: "ellipse" }, fill: "#111110", filters: [{ kind: "gaussian-blur", radius: 4 }], frame: { x: 120, y: 60, w: 30, h: 20 } },
          ...(existsSync(FONT)
            ? [{ id: "t", name: "T", type: "text" as const, content: "Hello <world> again", style: { font: "Bold", size: 14, fill: "#111110" }, runs: [{ text: "Hello " }, { text: "<world>", fill: "#FF4F1A" }, { text: " again" }], frame: { x: 10, y: 10, w: 180, h: 60 } }]
            : []),
        ],
      },
    ],
  };
  return { doc, loader: async ({ uri }) => (uri === "photo.jpg" ? photo : readFile(uri)) };
}

describe("writeSvg", () => {
  it("keeps shapes, gradients, masks and text as vector SVG", async () => {
    const { doc, loader } = await sample();
    const { svg, warnings } = await writeSvg(doc, "a", { loader });
    expect(warnings).toEqual([]);
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"[^>]* viewBox="0 0 200 100">/);
    expect(svg).toContain('<rect x="100" y="10" width="80" height="40" rx="8" fill="url(#gesso-gradient-');
    expect(svg).toContain('stop-color="#FFC21A" stop-opacity="0.502"');
    expect(svg).toContain("mix-blend-mode:multiply");
    expect(svg).toContain('data-name="Card &amp; co"');
    expect(svg).toMatch(/<mask id="gesso-mask-\d+" maskUnits="userSpaceOnUse"><g><rect [^>]*fill="#fff"\/><ellipse [^>]*fill="#000"\/>/);
    // The blurred ellipse can't be vector: it's an embedded image of just that layer.
    expect(svg).toMatch(/<image id="soft" data-name="Soft" x="\d+" y="\d+" width="\d+" height="\d+" href="data:image\/png;base64,/);
    if (existsSync(FONT)) {
      expect(svg).toContain("@font-face{font-family:\"Bold\"");
      expect(svg).toMatch(/<text font-family="Bold" font-size="14"[^>]*><tspan x="[\d.]+" y="[\d.]+">Hello <tspan fill="#FF4F1A">&lt;world&gt;<\/tspan>/);
    }
  });

  it("flattens what lies under an adjustment layer into one image", async () => {
    const { doc, loader } = await sample();
    doc.artboards[0]!.layers.splice(2, 0, { id: "warm", name: "Warm", type: "adjustment", adjustment: { kind: "hue-saturation", hue: 20, saturation: 0, lightness: 0 }, frame: { x: 0, y: 0, w: 200, h: 100 } });
    const { svg, warnings } = await writeSvg(doc, "a", { loader, embedFonts: false });
    expect(warnings[0]).toContain('layers up to "Warm" are flattened');
    expect(svg).toContain("<title>Flattened: Photo, Card &amp; co, Warm</title>");
    expect(svg).not.toContain("@font-face");
    expect(svg).toContain('id="soft"');
  });
});
