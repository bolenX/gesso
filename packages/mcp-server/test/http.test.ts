import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, readdir, utimes, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { download, isPrivate, resolvePath } from "../src/paths.js";
import { parseSlices } from "../src/slices.js";

type Text = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: unknown) => (result as Text).content.map((c) => c.text ?? "").join("\n");

describe("paths", () => {
  it("keeps confined paths inside the workspace", () => {
    expect(resolvePath("/w/abc", "uploads/a.png", true)).toBe("/w/abc/uploads/a.png");
    expect(() => resolvePath("/w/abc", "../other/a.png", true)).toThrow(/outside your workspace/);
    expect(() => resolvePath("/w/abc", "/etc/passwd", true)).toThrow(/outside your workspace/);
    expect(resolvePath("/w/abc", "/etc/hosts")).toBe("/etc/hosts");
  });

  it("recognises private and local addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivate(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) expect(isPrivate(a), a).toBe(false);
  });

  it("refuses confined downloads from local addresses", async () => {
    await expect(download("http://127.0.0.1:9/x.png", true)).rejects.toThrow(/private or local/);
    await expect(download("file:///etc/passwd", true)).rejects.toThrow(/Only http and https/);
  });

  it("keeps slice files inside the export folder", () => {
    expect(parseSlices("../../etc/x.png")[0]!.file).toBe("etc/x.png");
    expect(parseSlices("icons/logo.png")[0]!.file).toBe("icons/logo.png");
  });
});

describe("hosted HTTP server", () => {
  let base: string;
  let root: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gesso-hosted-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: root, hosted: true, maxMegapixels: 1 });
    base = started.url;
    close = started.close;
  });
  afterAll(() => close());

  const newWorkspace = async () => {
    const res = await fetch(`${base}/new`, { redirect: "manual" });
    expect(res.status).toBe(303);
    return res.headers.get("location")!.replace("/w/", "");
  };

  const connect = async (key: string) => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
    return client;
  };

  it("gives each workspace a page with its connector URL", async () => {
    const key = await newWorkspace();
    const page = await (await fetch(`${base}/w/${key}`)).text();
    expect(page).toContain(`/mcp/${key}`);
    expect((await fetch(`${base}/w/${"x".repeat(24)}`)).status).toBe(404);
    // Without a key, /mcp asks the app to sign in.
    const missing = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("uploads into the workspace, exports with download links, and keeps workspaces apart", async () => {
    const key = await newWorkspace();
    const png = await sharp({ create: { width: 40, height: 30, channels: 4, background: "#3366ff" } }).png().toBuffer();
    const put = await fetch(`${base}/files/${key}/uploads/blue photo.png`, { method: "PUT", body: png });
    expect(put.status).toBe(201);
    expect(await put.json()).toEqual({ path: "uploads/blue-photo.png", bytes: png.length });

    const client = await connect(key);
    const doc = {
      id: "card",
      revision: 0,
      assets: {},
      artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 80, h: 60 }, background: "#FFFFFF", layers: [] }],
    };
    expect((await client.callTool({ name: "canvas_create", arguments: { doc } })).isError).toBeFalsy();
    const imported = await client.callTool({ name: "asset_import", arguments: { doc: "card", id: "photo", source: "uploads/blue-photo.png" } });
    expect(imported.isError).toBeFalsy();

    const outside = await client.callTool({ name: "asset_import", arguments: { doc: "card", id: "secret", source: "/etc/hosts" } });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/outside your workspace/);
    const psd = await client.callTool({ name: "psd_import", arguments: { path: "../../x.psd" } });
    expect(textOf(psd)).toMatch(/outside your workspace/);

    const exported = await client.callTool({ name: "canvas_export", arguments: { doc: "card", outDir: "out", format: "png" } });
    const manifest = JSON.parse(textOf(exported)) as { files: Array<{ url: string }>; manifestUrl: string };
    expect(manifest.files[0]!.url).toBe(`${base}/files/${key}/out/a.png`);
    const file = await fetch(manifest.files[0]!.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    expect((await sharp(Buffer.from(await file.arrayBuffer())).metadata()).width).toBe(80);

    // The workspace's document history isn't served, and another workspace can't see this one.
    expect((await fetch(`${base}/files/${key}/.gesso/card.json`)).status).toBe(404);
    const other = await connect(await newWorkspace());
    expect(textOf(await other.callTool({ name: "canvas_list", arguments: {} }))).toMatch(/No documents/);
  });

  it("refuses renders over the size limit", async () => {
    const client = await connect(await newWorkspace());
    const doc = { id: "big", revision: 0, assets: {}, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 2000, h: 1000 }, layers: [] }] };
    await client.callTool({ name: "canvas_create", arguments: { doc } });
    const render = await client.callTool({ name: "canvas_render", arguments: { doc: "big", scale: 1 } });
    expect(render.isError).toBe(true);
    expect(textOf(render)).toMatch(/megapixels/);
    expect((await client.callTool({ name: "canvas_render", arguments: { doc: "big", scale: 0.5 } })).isError).toBeFalsy();
  });

  it("leaves out tools it's told to, and serves verification files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gesso-options-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: dir, hosted: true, disabledTools: ["gen_prepare"], verification: { "/.well-known/openai-apps-challenge": "token-123" } });
    try {
      const proof = await fetch(`${started.url}/.well-known/openai-apps-challenge`);
      expect(proof.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(await proof.text()).toBe("token-123");
      const key = (await fetch(`${started.url}/new`, { redirect: "manual" })).headers.get("location")!.replace("/w/", "");
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${started.url}/mcp/${key}`)));
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain("gen_prepare");
      expect(names).toContain("canvas_create");
    } finally {
      await started.close();
    }
  });

  it("counts new workspaces by the address a tunnel reports", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gesso-proxy-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: dir, hosted: true, clientIpHeader: "CF-Connecting-IP" });
    try {
      const create = (ip: string) => fetch(`${started.url}/new`, { redirect: "manual", headers: { "cf-connecting-ip": ip } }).then((r) => r.status);
      for (let i = 0; i < 20; i++) expect(await create("203.0.113.7")).toBe(303);
      expect(await create("203.0.113.7")).toBe(429);
      // Someone else behind the same tunnel isn't affected.
      expect(await create("198.51.100.9")).toBe(303);
    } finally {
      await started.close();
    }
  });

  it("deletes workspaces left idle", async () => {
    const stale = "s".repeat(24);
    const dir = join(root, "workspaces", stale);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".last"), "");
    const old = new Date(Date.now() - 30 * 86_400_000);
    await utimes(join(dir, ".last"), old, old);
    const restarted = await startHttp({ port: 0, host: "127.0.0.1", baseDir: root, hosted: true });
    await restarted.close();
    expect(await readdir(join(root, "workspaces"))).not.toContain(stale);
  });
});
