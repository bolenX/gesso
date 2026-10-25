import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Doc } from "@gesso/core";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";
import { parseSlices } from "../src/slices.js";

async function connect() {
  const baseDir = await mkdtemp(join(tmpdir(), "gesso-prod-"));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ baseDir }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { client, baseDir };
}

const call = async (client: Client, name: string, args: object) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
  if (result.isError) throw new Error(text);
  return { result, text, data: text.startsWith("{") ? JSON.parse(text) : undefined };
};

const poster: Doc = {
  id: "poster",
  revision: 0,
  assets: { photo: { uri: "photo.png", kind: "image" } },
  artboards: [
    {
      id: "post",
      name: "Post",
      frame: { x: 0, y: 0, w: 120, h: 80 },
      background: "#FFFFFF",
      layers: [
        { id: "photo", name: "photo", type: "image", asset: "photo", fit: "cover", frame: { x: 0, y: 0, w: 120, h: 80 } },
        { id: "logo", name: "200% logo.png, logo-small.jpg80", type: "shape", shape: { kind: "ellipse" }, fill: "#00C850", frame: { x: 10, y: 10, w: 20, h: 20 } },
        { id: "headline", name: "headline", type: "shape", shape: { kind: "rect" }, fill: "#FF4F1A", frame: { x: 50, y: 50, w: 60, h: 20 } },
      ],
    },
  ],
} as Doc;

describe("production tools", () => {
  it("reads asset-generator layer names", () => {
    expect(parseSlices("200% hero.png, hero-small.jpg80, 512x512 icon.webp")).toEqual([
      { file: "hero.png", format: "png", scale: 2, quality: 90 },
      { file: "hero-small.jpg", format: "jpeg", scale: 1, quality: 80 },
      { file: "icon.webp", format: "webp", scale: 1, quality: 90, size: [512, 512] },
    ]);
    expect(parseSlices("Headline")).toEqual([]);
  });

  it("exports TIFF, CMYK with a profile, slices and a soft proof", async () => {
    const { client, baseDir } = await connect();
    await writeFile(join(baseDir, "photo.png"), await sharp({ create: { width: 120, height: 80, channels: 3, background: "#3060C0" } }).png().toBuffer());
    await call(client, "canvas_create", { doc: poster });
    const { data } = await call(client, "canvas_export", { doc: "poster", outDir: "out", format: "tiff", color: "cmyk", profile: "cmyk", slices: true });
    const tif = data.files.find((f: { path: string }) => f.path.endsWith("post.tif"));
    expect(await sharp(tif.path).metadata()).toMatchObject({ format: "tiff", space: "cmyk", hasProfile: true });
    const logo = await sharp(join(baseDir, "out", "assets", "logo.png")).metadata();
    expect([logo.width, logo.height]).toEqual([40, 40]);
    expect((await sharp(join(baseDir, "out", "assets", "logo-small.jpg")).metadata()).space).toBe("cmyk");

    const proof = await client.callTool({ name: "canvas_render", arguments: { doc: "poster", scale: 1, proof: "cmyk" } });
    const png = (proof.content as Array<{ type: string; data?: string }>).find((c) => c.type === "image")!.data!;
    const { data: px } = await sharp(Buffer.from(png, "base64")).raw().toBuffer({ resolveWithObject: true });
    // The bright green logo is outside a press's gamut: the proof shows it duller.
    const at = (20 * 120 + 20) * 4;
    expect(px[at + 1]!).toBeLessThan(200);
  });

  it("stamps visible layers, and merges chosen ones", async () => {
    const { client, baseDir } = await connect();
    await writeFile(join(baseDir, "photo.png"), await sharp({ create: { width: 120, height: 80, channels: 3, background: "#3060C0" } }).png().toBuffer());
    await call(client, "canvas_create", { doc: poster });
    const stamped = await call(client, "canvas_stamp", { doc: "poster", artboard: "post", id: "stamp" });
    expect(stamped.data.changed).toContain("stamp");
    const merged = await call(client, "canvas_stamp", { doc: "poster", artboard: "post", id: "merged", layers: ["logo", "headline"], merge: true, region: { x: 0, y: 0, w: 120, h: 80 } });
    expect(merged.data.outline).not.toMatch(/headline/);
    const doc = (await call(client, "canvas_get", { doc: "poster", selectors: ["#merged"] })).text;
    expect(doc).toContain('"asset": "merged"');
    const pixels = await sharp(join(baseDir, "assets", "poster-merged.png")).raw().toBuffer({ resolveWithObject: true });
    // Merged layers only: transparent where only the photo was, green where the logo is.
    expect(pixels.data[(5 * 120 + 100) * 4 + 3]).toBe(0);
    expect(pixels.data[(20 * 120 + 20) * 4 + 1]).toBeGreaterThan(150);
  });

  it("runs a template over a folder of images and over data rows", async () => {
    const { client, baseDir } = await connect();
    await writeFile(join(baseDir, "photo.png"), await sharp({ create: { width: 120, height: 80, channels: 3, background: "#3060C0" } }).png().toBuffer());
    await mkdir(join(baseDir, "shots"));
    for (const [name, colour] of [["red", "#D02020"], ["yellow", "#E0C020"]]) await writeFile(join(baseDir, "shots", `${name}.png`), await sharp({ create: { width: 60, height: 40, channels: 3, background: colour! } }).png().toBuffer());
    await call(client, "canvas_create", { doc: poster });
    const { data } = await call(client, "canvas_batch", { doc: "poster", layer: "photo", sources: "shots", outDir: "batch", format: "jpeg" });
    expect(data.files.map((f: { row: string }) => f.row)).toEqual(["red", "yellow"]);
    const { data: red } = await sharp(join(baseDir, "batch", "red.jpg")).raw().toBuffer({ resolveWithObject: true });
    expect(red[(70 * 120 + 5) * 3]).toBeGreaterThan(180);

    const text: Doc = { id: "card", revision: 0, assets: {}, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 40, h: 20 }, layers: [{ id: "label", name: "label", type: "text", content: "x", style: { font: "Nope", size: 10 }, frame: { x: 0, y: 0, w: 40, h: 20 } }] }] } as Doc;
    await call(client, "canvas_create", { doc: text });
    const rows = await call(client, "canvas_batch", { doc: "card", rows: [{ name: "one", label: "First" }, { name: "two", label: "Second" }], outDir: "cards", format: "png" });
    expect(rows.data.files.map((f: { path: string }) => f.path.split("/").pop())).toEqual(["one.png", "two.png"]);
  });

  it("prepares a fill job with a mask in the image's own pixels", async () => {
    const { client, baseDir } = await connect();
    await writeFile(join(baseDir, "photo.png"), await sharp({ create: { width: 240, height: 80, channels: 3, background: "#3060C0" } }).png().toBuffer());
    await call(client, "canvas_create", { doc: poster });
    // The 240×80 photo is cropped to the middle 120×80 by cover: a region at the box's left edge is at x 60 in the image.
    const { data } = await call(client, "gen_prepare", { doc: "poster", job: "fill", artboard: "post", layer: "photo", regions: [{ at: [0.1, 0.5], size: [0.1, 0.2], shape: "rect" }] });
    expect(data).toMatchObject({ job: "fill", targetSize: [240, 80] });
    const { data: mask, info } = await sharp(data.files.mask).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => mask[(y * info.width + x) * info.channels]!;
    expect(at(72, 40)).toBe(255);
    expect(at(12, 40)).toBe(0);
    expect(data.ops[0].layer.mask.shape.kind).toBe("compound");
    expect(JSON.parse(await readFile(data.files.job, "utf8")).steps[0]).toMatch(/Inpaint/);
  });
});
