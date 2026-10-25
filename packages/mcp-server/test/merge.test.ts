import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

const text = (r: unknown) => (r as { content: Array<{ text?: string }> }).content[0]!.text!;

/** A textured scene shifted by [dx, dy]; `blurLeft` / `blurRight` soften one half (a focus slice). */
async function scene(dx: number, dy: number, soft?: "left" | "right"): Promise<Buffer> {
  const svg = `<svg width="240" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="240" height="160" fill="#6E8FB0"/><g transform="translate(${dx} ${dy})">
    <circle cx="60" cy="60" r="30" fill="#E8471A"/><rect x="130" y="40" width="70" height="90" fill="#F2E3C9"/>
    ${Array.from({ length: 40 }, (_, i) => `<rect x="${(i * 37) % 230}" y="${(i * 53) % 150}" width="5" height="5" fill="#${i % 2 ? "FFFFFF" : "000000"}"/>`).join("")}</g></svg>`;
  const sharpImg = await sharp(Buffer.from(svg)).png().toBuffer();
  if (!soft) return sharpImg;
  const blurred = await sharp(Buffer.from(svg)).blur(3).png().toBuffer();
  const half = await sharp(blurred).extract({ left: soft === "left" ? 0 : 120, top: 0, width: 120, height: 160 }).toBuffer();
  return sharp(sharpImg).composite([{ input: half, left: soft === "left" ? 0 : 120, top: 0 }]).png().toBuffer();
}

async function connect(files: Record<string, Buffer>) {
  const dir = await mkdtemp(join(tmpdir(), "gesso-merge-"));
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, name), bytes);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer({ baseDir: dir }).connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return client;
}

const layer = (id: string) => ({ id, name: id, type: "image", asset: id, fit: "fill", frame: { x: 0, y: 0, w: 240, h: 160 } });

describe("auto-align and auto-blend", () => {
  it("aligns a shifted frame onto the reference", async () => {
    const client = await connect({ "a.png": await scene(0, 0), "b.png": await scene(6, -3) });
    const doc = { id: "s", revision: 0, assets: { a: { uri: "a.png", kind: "image" }, b: { uri: "b.png", kind: "image" } }, artboards: [{ id: "x", name: "X", frame: { x: 0, y: 0, w: 240, h: 160 }, layers: [layer("a"), layer("b")] }] };
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const result = JSON.parse(text(await client.callTool({ name: "canvas_align", arguments: { doc: "s", artboard: "x", reference: "a", layers: ["b"] } })));
    expect(result.aligned[0].shift[0]).toBeCloseTo(-6, 0);
    expect(result.aligned[0].shift[1]).toBeCloseTo(3, 0);
    const b = JSON.parse(text(await client.callTool({ name: "canvas_get", arguments: { doc: "s", selectors: ["#b"] } })));
    expect(b[0].layer.frame.x).toBeCloseTo(-6, 0);
    expect(b[0].layer.frame.y).toBeCloseTo(3, 0);
  });

  it("focus-stacks two half-sharp frames into one sharp image", async () => {
    const client = await connect({ "near.png": await scene(0, 0, "right"), "far.png": await scene(0, 0, "left") });
    const doc = { id: "f", revision: 0, assets: { near: { uri: "near.png", kind: "image" }, far: { uri: "far.png", kind: "image" } }, artboards: [{ id: "x", name: "X", frame: { x: 0, y: 0, w: 240, h: 160 }, layers: [layer("near"), layer("far")] }] };
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const sharpness = async (region: object) => JSON.parse(text(await client.callTool({ name: "canvas_inspect", arguments: { doc: "f", region } }))).sharpness as number;
    const leftBefore = await sharpness({ x: 0, y: 0, w: 110, h: 160 });
    const stacked = JSON.parse(text(await client.callTool({ name: "canvas_stack", arguments: { doc: "f", artboard: "x", layers: ["near", "far"], mode: "focus" } })));
    expect(stacked.blended).toEqual(["near", "far"]);
    // Before, the top frame (far) is soft on the left; after, the left comes from the sharp near frame.
    expect(await sharpness({ x: 0, y: 0, w: 110, h: 160 })).toBeGreaterThan(leftBefore * 1.5);
    expect(await sharpness({ x: 130, y: 0, w: 110, h: 160 })).toBeGreaterThan(leftBefore * 1.5);
  });
});
