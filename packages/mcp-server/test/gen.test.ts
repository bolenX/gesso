import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

const text = (r: unknown) => (r as { content: Array<{ text?: string }> }).content[0]!.text!;

async function connect(files: Record<string, Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), "gesso-gen-"));
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ baseDir: dir }).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return { client, dir };
}

/** A 600×300 image split down the middle at x = 300: `left` and `right` colours. */
const split = (left: string, right: string, alpha = false) =>
  sharp(Buffer.from(`<svg width="600" height="300" xmlns="http://www.w3.org/2000/svg">${left === "none" ? "" : `<rect width="300" height="300" fill="${left}"/>`}${right === "none" ? "" : `<rect x="300" width="300" height="300" fill="${right}"/>`}</svg>`))
    .png()
    .toBuffer()
    .then((png) => (alpha ? png : sharp(png).flatten({ background: "#000000" }).png().toBuffer()));

describe("segmentation jobs", () => {
  // The photo is cropped (cover) into a frame that isn't the artboard, so a mask only lines up if it follows the photo.
  const doc = () => ({
    id: "seg",
    revision: 0,
    assets: { photo: { uri: "photo.png", kind: "image" } },
    artboards: [
      {
        id: "post",
        name: "Post",
        frame: { x: 0, y: 0, w: 400, h: 300 },
        background: "#FFFFFF",
        layers: [
          { id: "photo", name: "Photo", type: "image", asset: "photo", fit: "cover", frame: { x: 100, y: 50, w: 240, h: 200 } },
          { id: "tint", name: "Tint", type: "shape", shape: { kind: "rect" }, fill: "#00FF00", frame: { x: 0, y: 0, w: 400, h: 300 } },
        ],
      },
    ],
  });

  it("returns masks that follow the photo's crop onto another layer", async () => {
    const { client, dir } = await connect({ "photo.png": await split("#FF0000", "#0000FF") });
    await client.callTool({ name: "canvas_create", arguments: { doc: doc() } });
    const job = JSON.parse(text(await client.callTool({ name: "gen_prepare", arguments: { doc: "seg", job: "segment", artboard: "post", layer: "photo", targets: ["subject", "the red half"], onto: "tint" } })));
    expect(job.masks.map((m: { assetId: string }) => m.assetId)).toEqual(["segment-photo-r0-subject", "segment-photo-r0-the-red-half"]);
    expect(job.masks[0].prompt).toContain("Select Subject");
    expect(job.masks[0].mask).toEqual({ kind: "raster", asset: "segment-photo-r0-subject", of: "photo" });
    expect(job.targetSize).toEqual([600, 300]);

    // Stand in for the tool: a background remover's cut-out of the left (red) half, transparent elsewhere.
    await writeFile(join(dir, "cutout.png"), await split("#FF0000", "none", true));
    const imported = await client.callTool({ name: "asset_import", arguments: { doc: "seg", id: job.assetId, source: "cutout.png", kind: "mask" } });
    expect(imported.isError).toBeFalsy();
    const patched = await client.callTool({ name: "canvas_patch", arguments: { doc: "seg", baseRevision: 1, ops: job.ops } });
    expect(patched.isError).toBeFalsy();

    // Source x = 300 lands at artboard x = 220 (the crop shows source x 120..480 at 2/3 scale, from x = 100).
    const samples = async () =>
      JSON.parse(text(await client.callTool({ name: "canvas_inspect", arguments: { doc: "seg", samples: [[150, 150], [212, 150], [228, 150], [60, 150], [150, 20]], sampleSize: 1 } }))).samples.map(
        (s: { hex: string }) => s.hex,
      );
    // Green over the red half only: not over the blue half, and not outside the photo's frame.
    expect(await samples()).toEqual(["#00FF00", "#00FF00", "#0000FF", "#FFFFFF", "#FFFFFF"]);

    await client.callTool({ name: "canvas_patch", arguments: { doc: "seg", baseRevision: 2, ops: [{ op: "set", target: "#tint", path: "mask.invert", value: true }] } });
    expect(await samples()).toEqual(["#FF0000", "#FF0000", "#00FF00", "#00FF00", "#00FF00"]);

    // In a PSD it's a pixel mask on the tint layer.
    const exported = await client.callTool({ name: "canvas_export", arguments: { doc: "seg", outDir: "out", format: "psd" } });
    expect(exported.isError).toBeFalsy();
    await client.callTool({ name: "psd_import", arguments: { path: "out/seg.psd", id: "reopened" } });
    const reopened = await client.callTool({ name: "canvas_inspect", arguments: { doc: "reopened", samples: [[150, 150], [228, 150], [60, 150]], sampleSize: 1 } });
    expect(JSON.parse(text(reopened)).samples.map((s: { hex: string }) => s.hex)).toEqual(["#FF0000", "#00FF00", "#00FF00"]);
  });

  it("reads black-and-white masks by brightness and keeps them as grey", async () => {
    const { client, dir } = await connect({ "photo.png": await split("#FF0000", "#0000FF") });
    await client.callTool({ name: "canvas_create", arguments: { doc: doc() } });
    await writeFile(join(dir, "bw.jpg"), await sharp(await split("#000000", "#FFFFFF")).jpeg().toBuffer());
    const imported = JSON.parse(text(await client.callTool({ name: "asset_import", arguments: { doc: "seg", id: "right", source: "bw.jpg", kind: "mask" } })));
    expect(imported.uri ?? imported.asset?.uri).toMatch(/\.png$/);
    expect((await sharp(join(dir, "assets", "right.png")).metadata()).channels).toBe(1);
    const saved = await sharp(join(dir, "assets", "right.png")).extractChannel(0).raw().toBuffer();
    expect(saved[10 * 600 + 100]).toBeLessThan(10);
    expect(saved[10 * 600 + 500]).toBeGreaterThan(245);
  });

  it("refuses a mask that follows a layer that isn't an image", async () => {
    const { client } = await connect({ "photo.png": await split("#FF0000", "#0000FF") });
    const d = doc();
    (d.assets as Record<string, object>).m = { uri: "photo.png", kind: "mask" };
    await client.callTool({ name: "canvas_create", arguments: { doc: d } });
    const bad = await client.callTool({ name: "canvas_patch", arguments: { doc: "seg", baseRevision: 0, ops: [{ op: "set", target: "#photo", path: "mask", value: { kind: "raster", asset: "m", of: "tint" } }] } });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("isn't an image layer");
  });
});

describe("shared expand plates", () => {
  const board = (id: string, w: number, h: number, frame = { x: 0, y: 0, w, h }) => ({
    id,
    name: id,
    frame: { x: 0, y: 0, w, h },
    layers: [{ id: "bg", name: "Background", type: "image", asset: "photo", fit: "cover", frame }],
  });

  it("expands once for every size, lined up with the photo in each", { timeout: 20000 }, async () => {
    // A 4:5 post, a 9:16 story and a 16:9 landscape, at a fifth of their real size.
    const photo = await sharp({ create: { width: 216, height: 270, channels: 3, background: "#C04020" } }).png().toBuffer();
    const { client, dir } = await connect({ "photo.png": photo });
    const doc = { id: "set", revision: 0, assets: { photo: { uri: "photo.png", kind: "image" } }, artboards: [board("post", 216, 270), board("story", 216, 384), board("wide", 384, 216)] };
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const job = JSON.parse(text(await client.callTool({ name: "gen_prepare", arguments: { doc: "set", job: "expand", artboard: "post", layer: "bg", artboards: ["story", "wide"] } })));
    // The story needs 384 tall and the landscape 480 wide (at its 0.8 scale), in the photo's pixels.
    expect(job.expandBy).toEqual({ left: 132, top: 57, right: 132, bottom: 57 });
    expect(job.artboards).toEqual(["post", "story", "wide"]);
    expect(job.targetSize).toEqual([480, 384]);
    expect(job.ops).toHaveLength(12);
    expect(job.steps.join(" ")).toContain("covers all 3 artboards");

    await writeFile(join(dir, "plate.png"), await sharp({ create: { width: 480, height: 384, channels: 3, background: "#204060" } }).png().toBuffer());
    await client.callTool({ name: "asset_import", arguments: { doc: "set", id: job.assetId, source: "plate.png" } });
    const patched = await client.callTool({ name: "canvas_patch", arguments: { doc: "set", baseRevision: 1, ops: job.ops } });
    expect(patched.isError).toBeFalsy();

    const frames = JSON.parse(text(await client.callTool({ name: "canvas_get", arguments: { doc: "set", selectors: ["post #bg-plate", "story #bg-plate", "wide #bg-plate", "wide #bg"] } })));
    expect(frames.map((f: { layer: { frame: object } }) => f.layer.frame)).toEqual([
      { x: -132, y: -57, w: 480, h: 384 },
      { x: -132, y: 0, w: 480, h: 384 },
      { x: 0, y: -45.6, w: 384, h: 307.2 },
      { x: 105.6, y: 0, w: 172.8, h: 216 },
    ]);
    // Every size is filled: the plate at the edges, the photo in the middle.
    for (const [artboard, w, h] of [["story", 216, 384], ["wide", 384, 216]] as const) {
      const { samples } = JSON.parse(text(await client.callTool({ name: "canvas_inspect", arguments: { doc: "set", artboard, samples: [[2, 2], [w - 3, h - 3], [w / 2, h / 2]], sampleSize: 1 } })));
      expect(samples.map((s: { hex: string }) => s.hex)).toEqual(["#204060", "#204060", "#C04020"]);
    }
  });

  it("keeps the plate inside the frame when it would cover the rest of the layout", async () => {
    const photo = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#C04020" } }).png().toBuffer();
    const { client } = await connect({ "photo.png": photo });
    const doc = { id: "cards", revision: 0, assets: { photo: { uri: "photo.png", kind: "image" } }, artboards: [board("wide", 1000, 1000, { x: 100, y: 100, w: 400, h: 200 }), board("tall", 1000, 1000, { x: 100, y: 100, w: 200, h: 400 })] };
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const job = JSON.parse(text(await client.callTool({ name: "gen_prepare", arguments: { doc: "cards", job: "expand", artboard: "wide", layer: "bg", artboards: ["tall"] } })));
    expect(job.expandBy).toEqual({ left: 100, top: 100, right: 100, bottom: 100 });
    const plate = job.ops.find((o: { op: string; before?: string }) => o.op === "insert" && o.before === "wide #bg").layer;
    expect(plate.frame).toEqual({ x: 100, y: 0, w: 400, h: 400 });
    expect(plate.mask).toEqual({ kind: "vector", shape: { kind: "rect" }, frame: { x: 0, y: 100, w: 400, h: 200 } });
  });

  it("says when a size doesn't show the same image", async () => {
    const photo = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#C04020" } }).png().toBuffer();
    const { client } = await connect({ "photo.png": photo, "other.png": photo });
    const other = board("tall", 200, 400);
    other.layers[0]!.asset = "other";
    const doc = { id: "mixed", revision: 0, assets: { photo: { uri: "photo.png", kind: "image" }, other: { uri: "other.png", kind: "image" } }, artboards: [board("wide", 400, 200), other] };
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const result = await client.callTool({ name: "gen_prepare", arguments: { doc: "mixed", job: "expand", artboard: "wide", layer: "bg", artboards: ["tall"] } });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("doesn't show the same image");
  });
});
