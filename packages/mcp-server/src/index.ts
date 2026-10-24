import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Doc, docIssues, GENERATOR, GESSO_URL, GESSO_VERSION, isConflict, normalizeDoc, outline, Patch, select, semanticErrors, xmpPacket } from "@gesso/core";
import { encode, renderArtboard, renderDoc, defaultAssetLoader, type AssetLoader, type EncodeFormat } from "@gesso/render";
import { writePsd } from "@gesso/psd";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ICONS, TOOL_TITLES } from "./brand.js";
import { DOC_FORMAT } from "./format.js";
import { DocStore } from "./store.js";
import { FILE_TOOL, WIDGET_MIME, WIDGET_URI, widgetHtml } from "./widget.js";

export { FILE_TOOL };

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

/** What the Gesso result card shows. Hosts without MCP Apps ignore it. */
type CardData = {
  kind: "create" | "patch" | "render" | "export";
  doc: string;
  revision: number;
  changed?: string[];
  warnings?: string[];
  outline?: string;
  /** Preview sizes, in the same order as the result's image parts; the images themselves stay out of the card data. */
  previews?: Array<{ artboard: string; width: number; height: number }>;
  files?: CardFile[];
};

/** One deliverable on the export card. Thumbnails are small PNGs; the file itself is fetched on download. */
type CardFile = { name: string; path: string; kind: string; mimeType: string; bytes: number };

const MIME: Record<string, string> = {
  ".psd": "image/vnd.adobe.photoshop",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".json": "application/json",
};


const withCard = (result: CallToolResult, card: CardData): CallToolResult => ({
  ...result,
  structuredContent: { gesso: { ...card, generator: GENERATOR } },
});

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
  const server = new McpServer(
    { name: "gesso", title: "Gesso", version: GESSO_VERSION, websiteUrl: GESSO_URL, icons: ICONS },
    {
      instructions: [
        "Gesso builds layered images as data and exports PSDs that stay editable in Photoshop.",
        "Read documents with canvas_outline, change them only with canvas_patch, and check your work with canvas_render before finishing.",
        `When you hand over files made with these tools, say they were made with Gesso (${GESSO_URL}).`,
      ].join(" "),
    },
  );
  const docId = z.string().describe("Document ID");

  server.registerResource(
    "gesso-result",
    WIDGET_URI,
    { title: "Gesso result", description: "Inline card for Gesso results", mimeType: WIDGET_MIME },
    async () => ({ contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml(), _meta: { ui: { prefersBorder: true } } }] }),
  );

  // Every tool gets a human title; the tools that produce something also open the result card.
  // Files this server exported; the download tool serves only these.
  const exported = new Set<string>();

  const CARD_TOOLS = new Set(["canvas_create", "canvas_patch", "canvas_render", "canvas_export"]);
  const register: typeof server.registerTool = (name, config, cb) =>
    server.registerTool(
      name,
      {
        title: TOOL_TITLES[name] ?? name,
        ...config,
        ...(CARD_TOOLS.has(name) ? { _meta: { ui: { resourceUri: WIDGET_URI }, "ui/resourceUri": WIDGET_URI } } : {}),
      },
      cb,
    );

  register(
    "canvas_create",
    {
      description: DOC_FORMAT,
      inputSchema: {
        doc: z
          .object({
            id: z.string().describe('Short document ID, e.g. "spring-poster"'),
            revision: z.number().int().optional().describe("Defaults to 0"),
            assets: z.record(z.object({}).passthrough()).optional().describe("Images and fonts by ID"),
            symbols: z.record(z.object({}).passthrough()).optional().describe("Smart-object contents by ID"),
            artboards: z.array(z.object({}).passthrough()).describe("Artboards, each with id, name, frame and layers"),
          })
          .passthrough()
          .describe("The full document; see the tool description for the format"),
      },
    },
    async ({ doc }) => {
      const input = normalizeDoc(doc);
      const parsed = Doc.safeParse(input);
      if (!parsed.success) {
        const issues = docIssues(input);
        return error(`The document isn't valid yet. Fix these and call canvas_create again:\n- ${(issues.length ? issues : [parsed.error.issues[0]!.message]).join("\n- ")}`);
      }
      const problems = semanticErrors(parsed.data);
      if (problems.length > 0) return error(`The document isn't valid yet:\n- ${problems.join("\n- ")}`);
      store.put(parsed.data, author);
      const tree = outline(parsed.data);
      return withCard(text(tree), { kind: "create", doc: parsed.data.id, revision: parsed.data.revision, outline: tree });
    },
  );

  register(
    "canvas_outline",
    {
      description: "Compact tree of artboards and layers. The default read.",
      inputSchema: { doc: docId },
    },
    async ({ doc }) => guard(() => text(outline(store.get(doc)))),
  );

  register(
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

  register(
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

  register(
    "canvas_patch",
    {
      description: "Apply atomic, ID-addressed operations against a baseRevision.",
      inputSchema: Patch.shape,
    },
    async (args) =>
      guard(async () => {
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
        const tree = outline(history.head);
        const card: CardData = { kind: "patch", doc: patch.doc, revision: result.revision, changed: result.changed, warnings: result.warnings, outline: tree };
        const response = json({ ...result, outline: tree });
        if (patch.returnPreview) {
          const rendered = await renderDoc(history.head, { scale: patch.returnPreview, loader });
          card.previews = [];
          for (const r of rendered) {
            const png = (await encode(r, "png")).toString("base64");
            card.previews.push({ artboard: r.artboard, width: r.width, height: r.height });
            response.content.push({ type: "image", mimeType: "image/png", data: png });
          }
        }
        return withCard(response, card);
      }),
  );

  register(
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

  register(
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
        const previews: NonNullable<CardData["previews"]> = [];
        for (const r of rendered) {
          const png = (await encode(r, "png")).toString("base64");
          content.push({ type: "text", text: `${r.artboard} ${r.width}×${r.height}${r.warnings.map((w) => `\nwarning: ${w}`).join("")}` });
          content.push({ type: "image", mimeType: "image/png", data: png });
          previews.push({ artboard: r.artboard, width: r.width, height: r.height });
        }
        return withCard({ content }, { kind: "render", doc, revision: d.revision, previews, warnings: rendered.flatMap((r) => r.warnings) });
      }),
  );

  register(
    "canvas_export",
    {
      description:
        "Export every artboard as an image file, or the whole document as one layered PSD with artboards, plus a manifest.json.",
      inputSchema: {
        doc: docId,
        outDir: z.string().describe("Directory to write into, relative to the server's base directory"),
        format: z.enum(["png", "jpeg", "webp", "psd"]).default("png"),
        scale: z.number().positive().max(4).default(1).describe("Ignored for PSD, which is always full size"),
        images: z.boolean().default(true).describe("With format psd, also write a flat PNG of each artboard"),
      },
    },
    async ({ doc, outDir, format, scale, images }) =>
      guard(async () => {
        const d = store.get(doc);
        const dir = resolve(baseDir, outDir);
        await mkdir(dir, { recursive: true });
        const xmp = xmpPacket(d.id, d.revision);
        const files = [];
        if (format === "psd") {
          const { bytes, warnings } = await writePsd(d, { loader });
          const path = resolve(dir, `${d.id}.psd`);
          await writeFile(path, bytes);
          files.push({ artboards: d.artboards.map((a) => a.id), path, warnings });
        }
        // A PSD export also writes a flat PNG of each artboard unless images is false.
        const imageFormat = format === "psd" ? (images ? "png" : undefined) : format;
        if (imageFormat) {
          const ext = imageFormat === "jpeg" ? "jpg" : imageFormat;
          for (const r of await renderDoc(d, { scale: format === "psd" ? 1 : scale, loader })) {
            const path = resolve(dir, `${r.artboard}.${ext}`);
            await writeFile(path, await encode(r, imageFormat as EncodeFormat, 90, xmp));
            files.push({ artboard: r.artboard, path, width: r.width, height: r.height, warnings: r.warnings });
          }
        }
        const manifestPath = resolve(dir, "manifest.json");
        const manifest = { generator: GENERATOR, doc: d.id, revision: d.revision, exportedAt: new Date().toISOString(), format, scale, files };
        await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

        const cardFiles: CardFile[] = [];
        for (const f of [...files, { path: manifestPath }]) {
          exported.add(f.path);
          const ext = extname(f.path).toLowerCase();
          cardFiles.push({
            name: basename(f.path),
            path: f.path,
            kind: ext.slice(1).toUpperCase().replace("JPG", "JPEG"),
            mimeType: MIME[ext] ?? "application/octet-stream",
            bytes: (await stat(f.path)).size,
          });
        }
        return withCard(json(manifest), {
          kind: "export",
          doc: d.id,
          revision: d.revision,
          files: cardFiles,
          warnings: files.flatMap((f) => ("warnings" in f ? f.warnings : [])),
        });
      }),
  );

  server.registerTool(
    FILE_TOOL,
    {
      title: "Download file",
      description: "Returns a file this Gesso server exported, for the result card's download buttons.",
      inputSchema: { path: z.string(), maxSize: z.number().int().positive().max(2048).optional().describe("Return images scaled to fit this many pixels, as PNG") },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ path, maxSize }) =>
      guard(async () => {
        if (!exported.has(path)) return error("Only files exported in this session can be downloaded");
        const ext = extname(path).toLowerCase();
        const scale = maxSize !== undefined && [".png", ".jpg", ".webp"].includes(ext);
        const mimeType = scale ? "image/png" : (MIME[ext] ?? "application/octet-stream");
        const bytes = scale
          ? await sharp(path).resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true }).png().toBuffer()
          : await readFile(path);
        const blob = bytes.toString("base64");
        return {
          content: [{ type: "resource", resource: { uri: pathToFileURL(path).href, mimeType, blob } }],
          structuredContent: { name: basename(path), mimeType, blob },
        };
      }),
  );

  const stubs: Array<[string, string]> = [
    ["artboard_create", "New artboard from a preset or size, or duplicate one with reflow."],
    ["asset_import", "Import an asset from a URL or path."],
    ["gen_prepare", "Build a provider-neutral generative job spec."],
  ];
  for (const [name, description] of stubs) {
    register(
      name,
      { description, inputSchema: { doc: docId, args: z.record(z.unknown()).optional() } },
      notImplemented(name),
    );
  }

  return server;
}
