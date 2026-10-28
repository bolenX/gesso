import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

type Part = { type: string; text?: string; data?: string };
const parts = (result: unknown) => (result as { content: Part[] }).content;
const image = async (result: unknown) => {
  const data = parts(result).find((p) => p.type === "image")!.data!;
  const buf = Buffer.from(data, "base64");
  const { data: pixels, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, at: (x: number, y: number) => [...pixels.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)] };
};

async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer({ baseDir: await mkdtemp(join(tmpdir(), "gesso-inspect-")) }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  // A white artboard with a red square at 20,20 (20×20) and a blue dot at 60,10.
  const doc = {
    id: "card",
    revision: 0,
    assets: {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 100, h: 50 },
        background: "#FFFFFF",
        layers: [
          { id: "sq", name: "Square", type: "shape", shape: { kind: "rect" }, fill: "#FF0000", frame: { x: 20, y: 20, w: 20, h: 20 } },
          { id: "dot", name: "Dot", type: "shape", shape: { kind: "rect" }, fill: "#0000FF", frame: { x: 60, y: 10, w: 2, h: 2 } },
        ],
      },
    ],
  };
  await client.callTool({ name: "canvas_create", arguments: { doc } });
  return client;
}

describe("render views", () => {
  it("zooms into a region pixel by pixel", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "canvas_render", arguments: { doc: "card", region: { x: 58, y: 8, w: 6, h: 6 }, scale: 4 } });
    expect(parts(result)[0]!.text).toMatch(/region 58,8 6×6 at 400%/);
    const view = await image(result);
    expect([view.width, view.height]).toEqual([24, 24]);
    // The 2×2 dot covers pixels 8..15 of the zoomed view.
    expect(view.at(9, 9)).toEqual([0, 0, 255]);
    expect(view.at(2, 2)).toEqual([255, 255, 255]);
    const big = await client.callTool({ name: "canvas_render", arguments: { doc: "card", scale: 3 } });
    expect(big.isError).toBe(true);
  });

  it("compares with an earlier revision and with layers hidden", async () => {
    const client = await connect();
    await client.callTool({ name: "canvas_patch", arguments: { doc: "card", baseRevision: 0, ops: [{ op: "set", target: "#sq", path: "fill", value: "#00AA00" }] } });
    const side = await client.callTool({ name: "canvas_render", arguments: { doc: "card", scale: 1, compare: { revision: 0 } } });
    expect(parts(side)[0]!.text).toMatch(/Left: revision 0\. Right: now \(revision 1\)\. 8% of pixels changed/);
    expect(parts(side)[0]!.text).toMatch(/changes within x 20, y 20, 20×20/);
    const view = await image(side);
    expect(view.width).toBe(206);
    expect(view.at(30, 30)).toEqual([255, 0, 0]);
    expect(view.at(136, 30)).toEqual([0, 170, 0]);

    const hidden = await client.callTool({ name: "canvas_render", arguments: { doc: "card", scale: 1, compare: { hide: ["dot"], view: "difference" } } });
    expect(parts(hidden)[0]!.text).toMatch(/0\.08% of pixels changed/);
    const map = await image(hidden);
    expect(map.at(60, 10)[0]).toBeGreaterThan(200);
    expect(map.at(30, 30)[0]).toBe(0);
  });
});

describe("canvas_inspect", () => {
  it("measures, samples and maps", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "canvas_inspect",
      arguments: { doc: "card", samples: [[30, 30], [5, 5]], sampleSize: 1, map: "clipping" },
    });
    const stats = JSON.parse(parts(result)[0]!.text!);
    expect(stats.size).toEqual([100, 50]);
    expect(stats.luminance.clipped.highlights).toBeGreaterThan(80);
    expect(stats.samples[0]).toMatchObject({ at: [30, 30], hex: "#FF0000", hsb: [0, 100, 100] });
    expect(stats.samples[1].hex).toBe("#FFFFFF");
    const map = await image(result);
    expect(map.at(5, 5)).toEqual([255, 0, 0]);

    const square = JSON.parse(parts(await client.callTool({ name: "canvas_inspect", arguments: { doc: "card", layers: ["sq"] } }))[0]!.text!);
    expect(square.transparent).toBe(92);
    expect(square.color.mean).toBe("#FF0000");

    const region = JSON.parse(parts(await client.callTool({ name: "canvas_inspect", arguments: { doc: "card", region: { x: 20, y: 20, w: 20, h: 20 } } }))[0]!.text!);
    expect(region.channels.red.clippedHigh).toBe(100);
    expect(region.color.cast).toMatch(/magenta|warm/);
  });

  it("checks a layer as a cut-out, with a matte map", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "canvas_inspect", arguments: { doc: "card", layers: ["sq"], matte: true, map: "matte" } });
    const report = JSON.parse(parts(result)[0]!.text!);
    // A crisp square: a 1 px edge at most, no halo, specks or holes.
    expect(report.matte).toMatchObject({ solid: 8, haloTone: "none", specks: 0, holes: 0 });
    expect(report.matte.edgeWidth).toBeLessThanOrEqual(1);
    // Two by two: the mask, then over black, white and red.
    const map = await image(result);
    expect([map.width, map.height]).toEqual([206, 106]);
    expect(map.at(30, 30)).toEqual([255, 255, 255]);
    expect(map.at(106 + 5, 56 + 5)).toEqual([255, 0, 0]);
    const missing = await client.callTool({ name: "canvas_inspect", arguments: { doc: "card", matte: true } });
    expect(parts(missing)[0]!.text).toMatch(/needs layers/);
  });
});

describe("recipes and preflight", () => {
  it("lists a skill's recipes, applies one as a revision, and preflights the layout", async () => {
    const client = await connect();
    const read = parts(await client.callTool({ name: "skill_read", arguments: { name: "core-techniques" } }))[0]!.text!;
    expect(read).toMatch(/## Recipes[\s\S]*\*\*vignette\*\*/);
    expect(read).toMatch(/## Checks/);
    const applied = await client.callTool({ name: "skill_apply", arguments: { doc: "card", skill: "core-techniques", recipe: "vignette", params: { artboard: "a", above: "dot" } } });
    expect(applied.isError).toBeFalsy();
    expect(JSON.parse(parts(applied)[0]!.text!)).toMatchObject({ revision: 1, changed: ["vignette"] });
    const missing = await client.callTool({ name: "skill_apply", arguments: { doc: "card", skill: "core-techniques", recipe: "vignette", params: {} } });
    expect(parts(missing)[0]!.text).toMatch(/"artboard" is required/);

    await client.callTool({
      name: "canvas_patch",
      arguments: { doc: "card", baseRevision: 1, ops: [{ op: "insert", into: "#a", layer: { id: "tiny", name: "Tiny", type: "text", content: "fine print", style: { font: "Inter", size: 6 }, frame: { x: 90, y: 40, w: 30, h: 20 } } }] },
    });
    const report = JSON.parse(parts(await client.callTool({ name: "canvas_inspect", arguments: { doc: "card", preflight: true } }))[0]!.text!);
    expect(report.preflight).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ layer: "tiny", severity: "error", issue: expect.stringMatching(/extends past the artboard/) }),
        expect.objectContaining({ layer: "tiny", severity: "warning", issue: expect.stringMatching(/type at 6 px/) }),
      ]),
    );
  });
});
