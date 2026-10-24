import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createServer, FILE_TOOL, TOOL_NAMES } from "../src/index.js";
import { promo } from "../../core/test/fixtures.js";

async function connect(options: Parameters<typeof createServer>[0] = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Each test saves into its own temporary folder, never the repo.
  const baseDir = options.baseDir ?? (await mkdtemp(join(tmpdir(), "gesso-test-")));
  await createServer({ ...options, baseDir }).connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("gesso MCP server", () => {
  it("registers the v0.1 tool surface", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES, FILE_TOOL].sort());
    expect(tools.find((t) => t.name === FILE_TOOL)!._meta).toMatchObject({ ui: { visibility: ["app"] } });
  });

  it("presents itself as Gesso with a logo, tool titles and a result card", async () => {
    const client = await connect();
    expect(client.getServerVersion()).toMatchObject({ name: "gesso", title: "Gesso", websiteUrl: expect.stringContaining("gesso") });
    expect(client.getServerVersion()?.icons?.[0]?.src).toMatch(/^data:image\/svg\+xml;base64,/);
    const { tools } = await client.listTools();
    const render = tools.find((t) => t.name === "canvas_render")!;
    expect(render.title).toBe("Render preview");
    expect(render._meta).toMatchObject({ ui: { resourceUri: "ui://gesso/result.html" } });
    expect(tools.find((t) => t.name === "canvas_outline")!._meta).toBeUndefined();
    const { contents } = await client.readResource({ uri: "ui://gesso/result.html" });
    expect(contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
    expect((contents[0] as { text: string }).text).toContain("globalThis.GessoApp");

    const created = await client.callTool({ name: "canvas_create", arguments: { doc: promo } });
    expect(created.structuredContent).toMatchObject({ gesso: { kind: "create", doc: "promo-01", revision: 12, generator: expect.stringMatching(/^Gesso /) } });
  });

  it("documents the format and returns readable errors for a bad document", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const create = tools.find((t) => t.name === "canvas_create")!;
    expect(create.description).toContain('"type": "text", "content"');
    expect((create.inputSchema.properties as { doc: { type: string } }).doc.type).toBe("object");

    const bad = await client.callTool({ name: "canvas_create", arguments: { doc: { id: "x", artboards: [{ id: "a", width: 10, height: 10, layers: [{ id: "t", type: "text" }] }] } } });
    expect(bad.isError).toBe(true);
    const message = (bad.content as Array<{ text: string }>)[0]!.text;
    expect(message).toMatch(/^The document isn't valid yet/);
    expect(message).toContain('layers[0] "t" (text).content: required');
    expect(message).not.toContain("unionErrors");
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
    expect(JSON.stringify(preview.structuredContent)).not.toContain(image.data.slice(0, 40));
    expect(JSON.stringify(preview.structuredContent).length).toBeLessThan(1000);
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

    // The export card lists the PSD, a flat PNG per artboard and the manifest, each downloadable.
    const card = (psd.structuredContent as { gesso: { files: Array<{ name: string; kind: string; path: string; bytes: number; thumb?: string }> } }).gesso;
    expect(card.files.map((f) => [f.name, f.kind])).toEqual([["promo-01.psd", "PSD"], ["post-4x5.png", "PNG"], ["manifest.json", "JSON"]]);
    // No images in the card data: it reaches the agent as text, so it must stay small.
    expect(JSON.stringify(psd.structuredContent).length).toBeLessThan(2000);
    const thumb = await client.callTool({ name: FILE_TOOL, arguments: { path: card.files[1]!.path, maxSize: 64 } });
    const thumbFile = thumb.structuredContent as { mimeType: string; blob: string };
    expect(thumbFile.mimeType).toBe("image/png");
    expect((await sharp(Buffer.from(thumbFile.blob, "base64")).metadata()).height).toBe(64);
    expect(card.files[0]!.bytes).toBe(bytes.length);
    const download = await client.callTool({ name: FILE_TOOL, arguments: { path: card.files[0]!.path } });
    expect(Buffer.from((download.structuredContent as { blob: string }).blob, "base64").equals(bytes)).toBe(true);
    const refused = await client.callTool({ name: FILE_TOOL, arguments: { path: "/etc/hostname" } });
    expect(refused.isError).toBe(true);
  }, 30_000);

  it("saves documents and reopens them in a new server", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-save-"));
    const first = await connect({ baseDir });
    await first.callTool({ name: "canvas_create", arguments: { doc: promo } });
    await first.callTool({
      name: "canvas_patch",
      arguments: { doc: "promo-01", baseRevision: 12, ops: [{ op: "set", target: "#headline", path: "content", value: "Saved" }] },
    });
    const again = await first.callTool({ name: "canvas_create", arguments: { doc: promo } });
    expect(again.isError).toBe(true);
    expect((again.content as Array<{ text: string }>)[0]!.text).toContain('already exists (rev 13)');

    // A fresh server on the same folder, as after a restart or in a new session.
    const second = await connect({ baseDir });
    const listed = JSON.parse(((await second.callTool({ name: "canvas_list", arguments: {} })).content as Array<{ text: string }>)[0]!.text);
    expect(listed).toMatchObject([{ id: "promo-01", revision: 13, artboards: 1 }]);
    const outlineText = ((await second.callTool({ name: "canvas_outline", arguments: { doc: "promo-01" } })).content as Array<{ text: string }>)[0]!.text;
    expect(outlineText).toContain('"Saved"');
    const reverted = await second.callTool({ name: "canvas_history", arguments: { doc: "promo-01", revertTo: 12 } });
    expect((reverted.content as Array<{ text: string }>)[0]!.text).toContain("Summer Edit");

    const replaced = await second.callTool({ name: "canvas_create", arguments: { doc: promo, replace: true } });
    expect(replaced.isError).toBeFalsy();
  });

  it("finds fonts in the Gesso folder with ready asset entries", async () => {
    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    if (!existsSync(font)) return;
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-fonts-"));
    await copyFile(font, join(baseDir, "Brand.ttf"));
    const client = await connect({ baseDir });
    const result = await client.callTool({ name: "font_list", arguments: { query: "dejavu sans bold" } });
    const faces = JSON.parse((result.content as Array<{ text: string }>)[0]!.text.split(/\n\d+ more/)[0]!);
    expect(faces[0]).toMatchObject({ family: "DejaVu Sans", style: "Bold", weight: 700, asset: { uri: "Brand.ttf", kind: "font", family: "DejaVu Sans Bold", postscriptName: "DejaVuSans-Bold" } });
    const families = (await client.callTool({ name: "font_list", arguments: {} })).content as Array<{ text: string }>;
    expect(families[0]!.text).toContain("DejaVu Sans: ");
  });

  it("imports images and fonts as document assets", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-import-"));
    await sharp({ create: { width: 30, height: 20, channels: 3, background: "#FF4F1A" } }).png().toFile(join(baseDir, "photo.png"));
    const client = await connect({ baseDir });
    await client.callTool({ name: "canvas_create", arguments: { doc: promo } });
    const body = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>)[0]!.text;

    const local = JSON.parse(body(await client.callTool({ name: "asset_import", arguments: { doc: "promo-01", id: "shot", source: "photo.png" } })));
    expect(local).toMatchObject({ revision: 13, asset: { uri: "photo.png", kind: "image", width: 30, height: 20 } });

    const png = await sharp({ create: { width: 4, height: 6, channels: 3, background: "#000000" } }).jpeg().toBuffer();
    const pasted = JSON.parse(body(await client.callTool({ name: "asset_import", arguments: { doc: "promo-01", id: "pasted", data: png.toString("base64") } })));
    expect(pasted.asset).toMatchObject({ uri: "assets/pasted.jpg", width: 4, height: 6 });
    expect(existsSync(join(baseDir, "assets/pasted.jpg"))).toBe(true);

    const again = await client.callTool({ name: "asset_import", arguments: { doc: "promo-01", id: "shot", source: "photo.png" } });
    expect(again.isError).toBe(true);
    expect(body(again)).toContain("replace: true");

    const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
    if (existsSync(font)) {
      const imported = JSON.parse(body(await client.callTool({ name: "asset_import", arguments: { doc: "promo-01", id: "bold", source: font } })));
      expect(imported.asset).toMatchObject({ uri: font, kind: "font", family: "DejaVu Sans Bold", postscriptName: "DejaVuSans-Bold" });
    }
    const missing = await client.callTool({ name: "asset_import", arguments: { doc: "promo-01", id: "nope", source: "nope.png" } });
    expect(body(missing)).toContain("No file at");
  });

  it("adapts an artboard to a preset size", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-"));
    await sharp({ create: { width: 30, height: 40, channels: 3, background: "#c08040" } }).png().toFile(join(baseDir, "portrait.png"));
    const doc = structuredClone(promo);
    doc.assets.portrait!.uri = "portrait.png";
    const client = await connect({ baseDir });
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const from = promo.artboards[0]!.id;
    const result = await client.callTool({ name: "artboard_create", arguments: { doc: "promo-01", id: "story", preset: "instagram-story", from } });
    expect(result.isError).toBeFalsy();
    const [summary, preview] = result.content as Array<{ type: string; text?: string }>;
    expect(summary!.text).toContain(`Adapted from "${from}"`);
    expect(summary!.text).toContain("Safe zone");
    expect(preview!.type).toBe("image");
    const again = await client.callTool({ name: "artboard_create", arguments: { doc: "promo-01", id: "story", size: [100, 100] } });
    expect(again.isError).toBe(true);
    const unknown = await client.callTool({ name: "artboard_create", arguments: { doc: "promo-01", id: "x", preset: "nope" } });
    expect((unknown.content as Array<{ text: string }>)[0]!.text).toContain("Unknown preset");
  });

  it("prepares an expand job whose ops place the result with provenance", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-gen-"));
    await sharp({ create: { width: 400, height: 400, channels: 3, background: "#2440E6" } }).png().toFile(join(baseDir, "square.png"));
    const doc = {
      id: "wide", artboards: [{ id: "banner", frame: { x: 0, y: 0, w: 1600, h: 900 },
        layers: [{ id: "photo", type: "image", asset: "sq", fit: "cover", frame: { x: 0, y: 0, w: 1600, h: 900 } }] }],
      assets: { sq: { uri: "square.png", kind: "image" } },
    };
    const client = await connect({ baseDir });
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const body = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as Array<{ text: string }>)[0]!.text;
    const job = JSON.parse(body(await client.callTool({ name: "gen_prepare", arguments: { doc: "wide", job: "expand", artboard: "banner", layer: "photo" } })));
    expect(job).toMatchObject({ job: "expand", aspectRatio: "16:9", expandBy: { left: 155, top: 0, right: 156, bottom: 0 }, assetId: "expand-photo-r0" });
    const [mw, mh] = [(await sharp(job.files.mask).metadata()).width, (await sharp(job.files.padded).metadata()).height];
    expect([mw, mh]).toEqual(job.targetSize);

    // Stand in for the provider: any image of the target size.
    await sharp({ create: { width: job.targetSize[0], height: job.targetSize[1], channels: 3, background: "#FFC21A" } }).png().toFile(join(baseDir, "result.png"));
    await client.callTool({ name: "asset_import", arguments: { doc: "wide", id: job.assetId, source: "result.png" } });
    const patched = await client.callTool({ name: "canvas_patch", arguments: { doc: "wide", baseRevision: 1, ops: job.ops } });
    expect(patched.isError).toBeFalsy();
    const layers = JSON.parse(body(await client.callTool({ name: "canvas_get", arguments: { doc: "wide", selectors: ["#photo-plate", "#photo"] } })));
    expect(JSON.stringify(layers)).toContain('"op":"expand"');
    expect(JSON.stringify(layers)).toContain('"x":350');
  });

  it("opens an exported PSD as a new editable document", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-"));
    await sharp({ create: { width: 30, height: 40, channels: 3, background: "#c08040" } }).png().toFile(join(baseDir, "portrait.png"));
    const doc = structuredClone(promo);
    doc.assets.portrait!.uri = "portrait.png";
    const client = await connect({ baseDir });
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    await client.callTool({ name: "canvas_export", arguments: { doc: "promo-01", outDir: "out", format: "psd" } });

    const opened = await client.callTool({ name: "psd_import", arguments: { path: "out/promo-01.psd", id: "reopened" } });
    expect(opened.isError).toBeFalsy();
    const body = (opened.content as Array<{ text: string }>)[0]!.text;
    expect(body).toContain("headline");
    const again = await client.callTool({ name: "psd_import", arguments: { path: "out/promo-01.psd", id: "reopened" } });
    expect(again.isError).toBe(true);
    const render = await client.callTool({ name: "canvas_render", arguments: { doc: "reopened", scale: 0.1 } });
    expect(render.isError).toBeFalsy();
    const listed = (await client.callTool({ name: "canvas_list", arguments: {} })).content as Array<{ text: string }>;
    expect(listed[0]!.text).toContain("reopened");
  });

  it("keeps long exports running and hands over the files on the next call", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "gesso-"));
    await sharp({ create: { width: 30, height: 40, channels: 3, background: "#c08040" } }).png().toFile(join(baseDir, "portrait.png"));
    const doc = structuredClone(promo);
    doc.assets.portrait!.uri = "portrait.png";
    const client = await connect({ baseDir, exportWaitMs: 0 });
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const args = { doc: "promo-01", outDir: "out", format: "psd" };
    const first = await client.callTool({ name: "canvas_export", arguments: args });
    expect((first.content as Array<{ text: string }>)[0]!.text).toContain("Still exporting");
    let done;
    for (let i = 0; i < 100 && !done; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const again = await client.callTool({ name: "canvas_export", arguments: args });
      if (!(again.content as Array<{ text: string }>)[0]!.text.includes("Still exporting")) done = again;
    }
    expect(done?.isError).toBeFalsy();
    expect(JSON.parse((done!.content as Array<{ text: string }>)[0]!.text).files.map((f: { path: string }) => basename(f.path))).toEqual(["promo-01.psd", "post-4x5.png"]);
  });

  it("serves skills as prompts and through skill_read", async () => {
    const client = await connect();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("adapt-sizes");
    const read = await client.callTool({ name: "skill_read", arguments: { name: "adapt-sizes" } });
    expect((read.content as Array<{ text: string }>)[0]!.text).toContain("artboard_create");
    const prompt = await client.getPrompt({ name: "adapt-sizes" });
    expect(JSON.stringify(prompt.messages)).toContain("safe zone");
  });

});
