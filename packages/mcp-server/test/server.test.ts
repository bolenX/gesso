import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createServer, TOOL_NAMES } from "../src/index.js";
import { promo } from "../../core/test/fixtures.js";

async function connect(options: Parameters<typeof createServer>[0] = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(options).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("gesso MCP server", () => {
  it("registers the v0.1 tool surface", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("creates a document and reads it back", async () => {
    const client = await connect();
    const created = await client.callTool({ name: "canvas_create", arguments: { doc: promo } });
    expect(created.isError).toBeFalsy();

    const got = await client.callTool({
      name: "canvas_get",
      arguments: { doc: "promo-01", selectors: ["#headline"] },
    });
    const [first] = got.content as Array<{ text: string }>;
    expect(JSON.parse(first!.text)[0].layer.content).toBe("Summer Edit");
  });

  it("patches a document and reverts it through history", async () => {
    const client = await connect();
    await client.callTool({ name: "canvas_create", arguments: { doc: promo } });

    const patched = await client.callTool({
      name: "canvas_patch",
      arguments: {
        doc: "promo-01",
        baseRevision: 12,
        ops: [{ op: "set", target: "#headline", path: "content", value: "Autumn Edit" }],
      },
    });
    expect(patched.isError).toBeFalsy();
    const body = JSON.parse((patched.content as Array<{ text: string }>)[0]!.text);
    expect(body).toMatchObject({ revision: 13, changed: ["headline"] });
    expect(body.outline).toContain('"Autumn Edit"');

    const stale = await client.callTool({
      name: "canvas_patch",
      arguments: { doc: "promo-01", baseRevision: 12, ops: [{ op: "remove", target: "#card" }] },
    });
    expect(stale.isError).toBe(true);
    expect((stale.content as Array<{ text: string }>)[0]!.text).toContain('"currentRevision": 13');

    const reverted = await client.callTool({ name: "canvas_history", arguments: { doc: "promo-01", revertTo: 12 } });
    expect((reverted.content as Array<{ text: string }>)[0]!.text).toContain("Summer Edit");
  });

  it("returns invalid patches as tool errors", async () => {
    const client = await connect();
    await client.callTool({ name: "canvas_create", arguments: { doc: promo } });
    const result = await client.callTool({
      name: "canvas_patch",
      arguments: { doc: "promo-01", baseRevision: 12, ops: [{ op: "remove", target: "#nope" }] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("matches no layers");
  });

  it("renders previews and exports files with a manifest", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-"));
    await sharp({ create: { width: 30, height: 40, channels: 3, background: "#c08040" } }).png().toFile(join(baseDir, "portrait.png"));
    const doc = structuredClone(promo);
    doc.assets.portrait!.uri = "portrait.png";
    const client = await connect({ baseDir });
    await client.callTool({ name: "canvas_create", arguments: { doc } });

    const preview = await client.callTool({ name: "canvas_render", arguments: { doc: "promo-01", scale: 0.1 } });
    const [label, image] = preview.content as [{ text: string }, { type: string; data: string }];
    expect(label.text).toMatch(/^post-4x5 108×135/);
    expect(image.type).toBe("image");
    expect((await sharp(Buffer.from(image.data, "base64")).metadata()).width).toBe(108);

    const exported = await client.callTool({ name: "canvas_export", arguments: { doc: "promo-01", outDir: "out", format: "jpeg" } });
    expect(exported.isError).toBeFalsy();
    const manifest = JSON.parse(await readFile(join(baseDir, "out", "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ generator: expect.stringMatching(/^Gesso /), doc: "promo-01", revision: 12, format: "jpeg" });
    expect(((await sharp(join(baseDir, "out", "post-4x5.jpg")).metadata()).xmp ?? Buffer.alloc(0)).toString()).toContain("Gesso");
    expect((await sharp(join(baseDir, "out", "post-4x5.jpg")).metadata()).height).toBe(1350);

    const psd = await client.callTool({ name: "canvas_export", arguments: { doc: "promo-01", outDir: "out", format: "psd" } });
    expect(psd.isError).toBeFalsy();
    const bytes = await readFile(join(baseDir, "out", "promo-01.psd"));
    expect(bytes.subarray(0, 4).toString()).toBe("8BPS");
  });

  it("reports unimplemented tools as errors", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "gen_prepare", arguments: { doc: "promo-01" } });
    expect(result.isError).toBe(true);
  });
});
