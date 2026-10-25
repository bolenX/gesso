import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHttp } from "../src/http.js";
import { shardOf } from "../src/workers.js";

// Workers run the published bundle, so build it first (it takes a fraction of a second).
const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "../../gesso-mcp/dist/bin.mjs");

type Text = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const textOf = (result: unknown) => (result as Text).content.map((c) => c.text ?? "").join("\n");

describe("hosted workers", () => {
  let base: string;
  let close: () => Promise<void>;
  let workers: () => number[];

  beforeAll(async () => {
    execFileSync(process.execPath, [join(here, "../../gesso-mcp/build.mjs")]);
    const root = await mkdtemp(join(tmpdir(), "gesso-workers-"));
    const started = await startHttp({ port: 0, host: "127.0.0.1", baseDir: root, hosted: true, workers: { count: 2, entry: bundle } });
    ({ url: base, close, workers } = started);
  }, 60_000);
  afterAll(() => close());

  const workspace = async () => (await fetch(`${base}/new`, { redirect: "manual" })).headers.get("location")!.replace("/w/", "");
  const connect = async (key: string) => {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${key}`)));
    return client;
  };
  /** Two workspaces that land on different workers. */
  const apart = async () => {
    const a = await workspace();
    let b = await workspace();
    while (shardOf(b, 2) === shardOf(a, 2)) b = await workspace();
    return [a, b] as const;
  };

  it("runs tool calls in workers, with downloads from the main process", async () => {
    expect(workers()).toHaveLength(2);
    const client = await connect(await workspace());
    const doc = { id: "card", revision: 0, assets: {}, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: 80, h: 60 }, background: "#3366FF", layers: [] }] };
    expect((await client.callTool({ name: "canvas_create", arguments: { doc } })).isError).toBeFalsy();
    const exported = JSON.parse(textOf(await client.callTool({ name: "canvas_export", arguments: { doc: "card", outDir: "out", format: "png" } }))) as { files: Array<{ url: string }> };
    const file = await fetch(exported.files[0]!.url);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("image/png");
    // The document is still there on the next request, in the same worker.
    expect(textOf(await client.callTool({ name: "canvas_list", arguments: {} }))).toContain("card");
  });

  it("keeps answering other workspaces while one renders", { timeout: 60_000 }, async () => {
    const [busy, idle] = await apart();
    const heavy = await connect(busy);
    const size = 1800;
    const doc = {
      id: "heavy",
      revision: 0,
      assets: {},
      artboards: [
        {
          id: "a",
          name: "A",
          frame: { x: 0, y: 0, w: size, h: size },
          layers: [
            {
              id: "s",
              name: "s",
              type: "shape",
              shape: { kind: "ellipse" },
              fill: { kind: "linear-gradient", angle: 45, stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] },
              frame: { x: 0, y: 0, w: size, h: size },
              filters: [{ kind: "oil-paint", stylization: 5, cleanliness: 5 }, { kind: "median", radius: 6 }],
            },
          ],
        },
      ],
    };
    const made = await heavy.callTool({ name: "canvas_create", arguments: { doc } });
    expect(made.isError, textOf(made)).toBeFalsy();
    const other = await connect(idle);
    const started = Date.now();
    let rendered = 0;
    const render = heavy.callTool({ name: "canvas_inspect", arguments: { doc: "heavy" } }).then((r) => {
      expect(r.isError, textOf(r)).toBeFalsy();
      rendered = Date.now() - started;
    });
    await new Promise((r) => setTimeout(r, 300));
    const t = Date.now();
    expect(textOf(await other.callTool({ name: "canvas_list", arguments: {} }))).toMatch(/No documents/);
    const quick = Date.now() - t;
    expect((await fetch(`${base}/health`)).status).toBe(200);
    await render;
    // The other workspace answered long before the render finished.
    expect(rendered).toBeGreaterThan(1500);
    expect(quick).toBeLessThan(rendered / 2);
  });

  it("restarts a worker that dies, and only its requests fail", { timeout: 60_000 }, async () => {
    const [a, b] = await apart();
    const left = await connect(a);
    const right = await connect(b);
    const pids = workers();
    // Kill the worker for workspace a.
    process.kill(pids[shardOf(a, 2)]!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 100));
    expect((await right.callTool({ name: "canvas_list", arguments: {} })).isError).toBeFalsy();
    await expect(left.callTool({ name: "canvas_list", arguments: {} })).rejects.toThrow(/restarting|503/);
    // It's back within a few seconds.
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      await new Promise((r) => setTimeout(r, 250));
      back = await left.callTool({ name: "canvas_list", arguments: {} }).then(
        () => true,
        () => false,
      );
    }
    expect(back).toBe(true);
    expect(workers()).toHaveLength(2);
    expect(workers()).not.toContain(pids[shardOf(a, 2)]);
  });
});
