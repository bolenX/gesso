import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Doc, isConflict, outline, Patch, select, semanticErrors } from "@gesso/core";
import { encode, renderArtboard, renderDoc, defaultAssetLoader, type AssetLoader, type EncodeFormat } from "@gesso/render";
import { writePsd } from "@gesso/psd";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { DocStore } from "./store.js";

export { DocStore };

// The v0.1 tool surface. See docs/spec-v0.1.md, "Agent interface".
export const TOOL_NAMES = [
  "canvas_create",
  "canvas_outline",
  "canvas_get",
  "canvas_selection",
  "canvas_patch",
  "canvas_render",
  "artboard_create",
  "canvas_export",
  "asset_import",
  "canvas_history",
  "gen_prepare",
] as const;

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

const json = (value: unknown): CallToolResult => text(JSON.stringify(value, null, 2));

const error = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/** Turns expected failures (bad selectors, invalid patches) into tool errors the agent can act on. */
async function guard(run: () => CallToolResult | Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof Error) return error(err.message);
    throw err;
  }
}

const notImplemented = (tool: string) => async (): Promise<CallToolResult> => ({
  isError: true,
  content: [{ type: "text", text: `${tool} is not implemented yet` }],
});

export type ServerOptions = {
  store?: DocStore;
  author?: string;
  /** Where relative asset paths and export directories resolve. */
  baseDir?: string;
  loader?: AssetLoader;
};

export function createServer({
  store = new DocStore(),
  author = "agent",
  baseDir = process.cwd(),
  loader = defaultAssetLoader(baseDir),
}: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "gesso", version: "0.0.0" });
  const docId = z.string().describe("Document ID");

  server.registerTool(
    "canvas_create",
    {
      description: "Create a document from a full spec. Returns the outline.",
      inputSchema: { doc: z.unknown().describe("A complete Gesso document") },
    },
    async ({ doc }) => {
      const parsed = Doc.safeParse(doc);
      if (!parsed.success) return error(parsed.error.message);
      const problems = semanticErrors(parsed.data);
      if (problems.length > 0) return error(problems.join("; "));
      store.put(parsed.data, author);
      return text(outline(parsed.data));
    },
  );

  server.registerTool(
    "canvas_outline",
    {
      description: "Compact tree of artboards and layers. The default read.",
      inputSchema: { doc: docId },
    },
    async ({ doc }) => guard(() => text(outline(store.get(doc)))),
  );

  server.registerTool(
    "canvas_get",
    {
      description: "Full JSON for the layers matching the given selectors.",
      inputSchema: { doc: docId, selectors: z.array(z.string()).min(1) },
    },
    async ({ doc, selectors }) =>
      guard(() => {
        const d = store.get(doc);
        return json(selectors.flatMap((s) => select(d, s, store.selection(doc))));
      }),
  );

  server.registerTool(
    "canvas_selection",
    {
      description: "Read the current selection, or set it by passing layer IDs.",
      inputSchema: { doc: docId, set: z.array(z.string()).optional() },
    },
    async ({ doc, set }) =>
      guard(() => {
        store.get(doc);
        if (set) store.setSelection(doc, set);
        return text(JSON.stringify(store.selection(doc)));
      }),
  );

  server.registerTool(
    "canvas_patch",
    {
      description: "Apply atomic, ID-addressed operations against a baseRevision.",
      inputSchema: Patch.shape,
    },
    async (args) =>
      guard(() => {
        const patch = Patch.parse(args);
        const history = store.history(patch.doc);
        const result = history.apply(patch, author, { selection: store.selection(patch.doc) });
        if (isConflict(result)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Stale baseRevision; rebase onto the ops below.\n${JSON.stringify(result, null, 2)}` }],
          };
        }
        if (patch.dryRun) return json({ ...result, dryRun: true });
        return json({ ...result, outline: outline(history.head) });
      }),
  );

  server.registerTool(
    "canvas_history",
    {
      description: "List revisions, or revert to an earlier one (recorded as a new revision).",
      inputSchema: { doc: docId, revertTo: z.number().int().nonnegative().optional() },
    },
    async ({ doc, revertTo }) =>
      guard(() => {
        const history = store.history(doc);
        if (revertTo !== undefined) {
          const reverted = history.revert(revertTo, author);
          return json({ revision: reverted.revision, outline: outline(reverted) });
        }
        return json(history.revisions());
      }),
  );

  server.registerTool(
    "canvas_render",
    {
      description: "Render artboards to preview images. Use a small scale (default 0.5) to save tokens.",
      inputSchema: {
        doc: docId,
        artboard: z.string().optional().describe("Artboard ID; omit to render every artboard"),
        scale: z.number().positive().max(2).default(0.5),
      },
    },
    async ({ doc, artboard, scale }) =>
      guard(async () => {
        const d = store.get(doc);
        const rendered = artboard ? [await renderArtboard(d, artboard, { scale, loader })] : await renderDoc(d, { scale, loader });
        const content: CallToolResult["content"] = [];
        for (const r of rendered) {
          content.push({ type: "text", text: `${r.artboard} ${r.width}×${r.height}${r.warnings.map((w) => `\nwarning: ${w}`).join("")}` });
          content.push({ type: "image", mimeType: "image/png", data: (await encode(r, "png")).toString("base64") });
        }
        return { content };
      }),
  );

  server.registerTool(
    "canvas_export",
    {
      description:
        "Export every artboard as an image file, or the whole document as one layered PSD with artboards, plus a manifest.json.",
      inputSchema: {
        doc: docId,
        outDir: z.string().describe("Directory to write into, relative to the server's base directory"),
        format: z.enum(["png", "jpeg", "webp", "psd"]).default("png"),
        scale: z.number().positive().max(4).default(1).describe("Ignored for PSD, which is always full size"),
      },
    },
    async ({ doc, outDir, format, scale }) =>
      guard(async () => {
        const d = store.get(doc);
        const dir = resolve(baseDir, outDir);
        await mkdir(dir, { recursive: true });
        const files = [];
        if (format === "psd") {
          const { bytes, warnings } = await writePsd(d, { loader });
          const path = resolve(dir, `${d.id}.psd`);
          await writeFile(path, bytes);
          files.push({ artboards: d.artboards.map((a) => a.id), path, warnings });
        }
        const ext = format === "jpeg" ? "jpg" : format;
        for (const r of format === "psd" ? [] : await renderDoc(d, { scale, loader })) {
          const path = resolve(dir, `${r.artboard}.${ext}`);
          await writeFile(path, await encode(r, format as EncodeFormat));
          files.push({ artboard: r.artboard, path, width: r.width, height: r.height, warnings: r.warnings });
        }
        const manifest = { doc: d.id, revision: d.revision, exportedAt: new Date().toISOString(), format, scale, files };
        await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
        return json(manifest);
      }),
  );

  const stubs: Array<[string, string]> = [
    ["artboard_create", "New artboard from a preset or size, or duplicate one with reflow."],
    ["asset_import", "Import an asset from a URL or path."],
    ["gen_prepare", "Build a provider-neutral generative job spec."],
  ];
  for (const [name, description] of stubs) {
    server.registerTool(
      name,
      { description, inputSchema: { doc: docId, args: z.record(z.unknown()).optional() } },
      notImplemented(name),
    );
  }

  return server;
}
