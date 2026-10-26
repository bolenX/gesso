import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { FILE_TOOL, scrubber } from "../src/index.js";

type Result = { content: Array<{ type: string; text?: string }>; structuredContent?: { gesso?: { files?: Array<{ name: string; path: string; url?: string }> } }; isError?: boolean };
const textOf = (r: unknown) => (r as Result).content.map((c) => c.text ?? "").join("\n");
const FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

describe("a hosted server keeps its own folders private", () => {
  let root: string;
  let fonts: string;
  let base: string;
  let close: () => Promise<void>;
  const saved = process.env.GESSO_FONT_DIRS;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gesso-privacy-"));
    fonts = await mkdtemp(join(tmpdir(), "gesso-server-fonts-"));
    if (existsSync(FONT)) await copyFile(FONT, join(fonts, "DejaVuSans-Bold.ttf"));
    process.env.GESSO_FONT_DIRS = fonts;
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: root, hosted: true });
    base = started.url;
    close = started.close;
  });
  afterAll(async () => {
    await close();
    if (saved === undefined) delete process.env.GESSO_FONT_DIRS;
    else process.env.GESSO_FONT_DIRS = saved;
  });

  it("rewrites workspace paths and the home folder out of text", () => {
    const scrub = scrubber("/srv/data/workspaces/abc");
    expect(scrub("saved /srv/data/workspaces/abc/out/a.png, in /srv/data/workspaces/abc")).toBe("saved out/a.png, in .");
  });

  it("lists, exports and prepares jobs without server paths, and puts download links in the structured result", async () => {
    const key = (await fetch(`${base}/new`, { redirect: "manual" })).headers.get("location")!.replace("/w/", "");
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
    const seen: unknown[] = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      seen.push(result);
      return result;
    };

    // Fonts come from GESSO_FONT_DIRS only, named without saying where that folder is.
    const assets: Record<string, unknown> = {};
    if (existsSync(FONT)) {
      const faces = JSON.parse(textOf(await call("font_list", { query: "dejavu sans bold" })));
      expect(faces[0].asset.uri).toBe("font:DejaVuSans-Bold.ttf");
      assets.bold = faces[0].asset;
    }
    const doc = {
      id: "private",
      assets,
      artboards: [{
        id: "post", name: "Post", frame: { x: 0, y: 0, w: 200, h: 120 }, background: "#FFFFFF",
        layers: existsSync(FONT) ? [{ id: "title", name: "Title", type: "text", content: "Hi", style: { font: "DejaVu Sans Bold", size: 40, fill: "#111110" }, frame: { x: 10, y: 10, w: 180, h: 60 } }] : [],
      }],
    };
    expect((await call("canvas_create", { doc })).isError).toBeFalsy();
    const photo = (await sharp({ create: { width: 40, height: 30, channels: 3, background: "#FF4F1A" } }).png().toBuffer()).toString("base64");
    expect((await call("asset_import", { doc: "private", id: "photo", data: photo })).isError).toBeFalsy();
    const placed = await call("canvas_patch", { doc: "private", baseRevision: 1, ops: [{ op: "insert", into: "#post", layer: { id: "shot", name: "Shot", type: "image", asset: "photo", fit: "cover", frame: { x: 0, y: 70, w: 80, h: 50 } } }] });
    expect((placed as Result).isError, textOf(placed)).toBeFalsy();
    const rendered = await call("canvas_render", { doc: "private" });
    expect((rendered as Result).isError, textOf(rendered)).toBeFalsy();

    const exported = (await call("canvas_export", { doc: "private", outDir: "out", format: "psd" })) as Result;
    const files = exported.structuredContent!.gesso!.files!;
    expect(files.map((f) => f.path).sort()).toEqual(["out/manifest.json", "out/post.png", "out/private.psd"]);
    for (const f of files) expect(f.url).toMatch(new RegExp(`^${base}/files/`));
    const workspace = join(root, "workspaces", key);
    expect(await readFile(join(workspace, "out", "manifest.json"), "utf8")).not.toContain(root);

    // The result card's download button sends the relative path back.
    const download = (await client.callTool({ name: FILE_TOOL, arguments: { path: "out/post.png" } })) as { content: Array<{ resource?: { uri: string; blob: string } }> };
    expect(download.content[0]!.resource!.uri).toMatch(/^http/);
    expect(Buffer.from(download.content[0]!.resource!.blob, "base64").subarray(1, 4).toString()).toBe("PNG");

    const job = JSON.parse(textOf(await call("gen_prepare", { doc: "private", artboard: "post", layer: "shot", job: "upscale" })));
    expect(job.files.source).toBe(`jobs/${job.id}/source.png`);
    expect(await readFile(join(workspace, "jobs", job.id, "job.json"), "utf8")).not.toContain(root);

    const missing = await call("asset_import", { doc: "private", id: "nope", source: "uploads/missing.png" });
    expect((missing as Result).isError).toBe(true);

    for (const result of seen) expect(JSON.stringify(result)).not.toContain(root);
    expect(JSON.stringify(seen)).not.toContain(fonts);
  });
});
