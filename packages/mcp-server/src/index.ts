import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Doc, docIssues, GENERATOR, GESSO_URL, GESSO_VERSION, isConflict, normalizeDoc, outline, Patch, PRESETS, presetList, reflowArtboard, select, semanticErrors, xmpPacket } from "@gesso/core";
import { encode, renderArtboard, renderDoc, defaultAssetLoader, fontUri, scanFonts, systemFontDirs, type AssetLoader, type EncodeFormat, type InstalledFont } from "@gesso/render";
import { writePsd } from "@gesso/psd";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ICONS, TOOL_TITLES } from "./brand.js";
import { DOC_FORMAT } from "./format.js";
import { prepareJob } from "./gen.js";
import { importAsset } from "./import.js";
import { loadSkills } from "./skills.js";
import { DocStore } from "./store.js";
import { FILE_TOOL, WIDGET_MIME, WIDGET_URI, widgetHtml } from "./widget.js";

export { FILE_TOOL };

export { DocStore };

// The v0.1 tool surface. See docs/spec-v0.1.md, "Agent interface".
export const TOOL_NAMES = [
  "canvas_list",
  "canvas_create",
  "canvas_outline",
  "canvas_get",
  "canvas_selection",
  "canvas_patch",
  "canvas_render",
  "artboard_create",
  "canvas_export",
  "font_list",
  "skill_read",
  "asset_import",
  "canvas_history",
  "gen_prepare",
] as const;

/** How much the width:height ratio changes, as a factor of at least 1. */
const aspectChange = (a: { w: number; h: number }, b: { w: number; h: number }) => {
  const r = a.w / a.h / (b.w / b.h);
  return Math.max(r, 1 / r);
};

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

export type ServerOptions = {
  /** Defaults to a store that saves documents under baseDir/.gesso. */
  store?: DocStore;
  author?: string;
  /** Where relative asset paths and export directories resolve. */
  baseDir?: string;
  loader?: AssetLoader;
};

export function createServer({
  author = "agent",
  baseDir = process.cwd(),
  store = new DocStore(baseDir),
  loader = defaultAssetLoader(baseDir),
}: ServerOptions = {}): McpServer {
  const skills = loadSkills();
  const server = new McpServer(
    { name: "gesso", title: "Gesso", version: GESSO_VERSION, websiteUrl: GESSO_URL, icons: ICONS },
    {
      instructions: [
        "Gesso builds layered images as data and exports PSDs that stay editable in Photoshop.",
        "Read documents with canvas_outline, change them only with canvas_patch, and check your work with canvas_render before finishing.",
        `When you hand over files made with these tools, say they were made with Gesso (${GESSO_URL}).`,
        ...(skills.length
          ? [`For these tasks, read the matching recipe with skill_read first: ${skills.map((s) => `${s.name} (${s.description})`).join("; ")}.`]
          : []),
      ].join(" "),
    },
  );
  const docId = z.string().describe("Document ID");

  // Each skill is a prompt the user can run as a slash command, and readable by the agent through skill_read.
  for (const skill of skills) {
    server.registerPrompt(skill.name, { title: skill.name, description: skill.description }, () => ({
      messages: [{ role: "user", content: { type: "text", text: skill.body } }],
    }));
  }

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
    "canvas_list",
    {
      description: "List saved documents (id, revision, artboards, last change), newest first. Documents are saved after every change and reopen by id in any tool.",
      inputSchema: {},
    },
    async () =>
      guard(() => {
        const docs = store.list();
        return docs.length ? json(docs) : text("No documents yet. Start one with canvas_create.");
      }),
  );

  // Scanned once per server, on first use: system folders change rarely, and a scan takes a moment.
  let fonts: Promise<InstalledFont[]> | undefined;
  const installedFonts = () =>
    (fonts ??= Promise.all([scanFonts([baseDir], 2), scanFonts(systemFontDirs())]).then(([own, system]) => [...own, ...system]));

  register(
    "font_list",
    {
      description:
        "Find fonts on this computer and in the Gesso folder. Without a query, lists the font families. With one, lists matching faces, each with the asset entry to put in doc.assets (then use its family as style.font).",
      inputSchema: {
        query: z.string().optional().describe('Words to match in the family, style or PostScript name, e.g. "inter bold" or "serif"'),
        limit: z.number().int().positive().max(200).optional().describe("Most faces to list; default 30"),
      },
    },
    async ({ query, limit = 30 }) =>
      guard(async () => {
        const all = await installedFonts();
        if (!all.length) return text("No fonts found. Put .ttf or .otf files in the Gesso folder.");
        if (!query?.trim()) {
          const families = new Map<string, Set<string>>();
          for (const f of all) (families.get(f.family) ?? families.set(f.family, new Set()).get(f.family)!).add(f.style);
          const lines = [...families].sort(([a], [b]) => a.localeCompare(b)).map(([family, styles]) => `${family}: ${[...styles].join(", ")}`);
          return text(`${families.size} families. Call font_list with a query to get asset entries.\n${lines.join("\n")}`);
        }
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matches = all.filter((f) => {
          const hay = `${f.family} ${f.style} ${f.fullName} ${f.postscriptName ?? ""}`.toLowerCase();
          return words.every((w) => hay.includes(w));
        });
        if (!matches.length) return text(`No fonts match "${query}". Call font_list without a query to see every family.`);
        const faces = matches.slice(0, limit).map((f) => ({
          family: f.family,
          style: f.style,
          weight: f.weight,
          ...(f.italic ? { italic: true } : {}),
          asset: {
            uri: fontUri(f.path, baseDir),
            kind: "font",
            family: f.fullName,
            ...(f.postscriptName ? { postscriptName: f.postscriptName } : {}),
            ...(f.face ? { face: f.face } : {}),
          },
        }));
        const more = matches.length > faces.length ? `\n${matches.length - faces.length} more; narrow the query or raise limit.` : "";
        return text(JSON.stringify(faces, null, 2) + more);
      }),
  );

  register(
    "asset_import",
    {
      description:
        "Add an image or font to a document's assets from a path, a URL or base64 data. Reads the image size, or the font's family and PostScript name, and returns the entry. Downloads and pasted data are saved in the Gesso folder under assets/. Use the id in image layers (\"asset\") or the family in text styles (\"font\").",
      inputSchema: {
        doc: docId,
        id: z.string().describe('Asset ID to use in layers, e.g. "hero-photo"'),
        source: z.string().optional().describe("Path (relative to the Gesso folder, or absolute) or http(s) URL"),
        data: z.string().optional().describe("Base64 file contents, when there's no path or URL"),
        kind: z.enum(["image", "font", "mask"]).optional().describe("Detected from the file when left out"),
        face: z.number().int().nonnegative().optional().describe("Face index in a .ttc font collection"),
        description: z.string().optional(),
        replace: z.boolean().optional().describe("Replace an existing asset with this id"),
      },
    },
    async ({ doc, replace, ...request }) =>
      guard(async () => {
        const history = store.history(doc);
        if (request.id in history.head.assets && !replace) {
          return error(`Asset "${request.id}" already exists: ${JSON.stringify(history.head.assets[request.id])}. Pass replace: true to swap it, or use another id.`);
        }
        const asset = await importAsset(request, baseDir);
        const result = history.apply({ doc, baseRevision: history.head.revision, ops: [{ op: "asset", id: request.id, asset }] }, author);
        if (isConflict(result)) return error("The document changed while importing; try again.");
        store.save(doc);
        return json({ revision: result.revision, id: request.id, asset });
      }),
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
        replace: z.boolean().optional().describe("Overwrite a saved document with the same id, discarding its history"),
      },
    },
    async ({ doc, replace }) => {
      const input = normalizeDoc(doc);
      const parsed = Doc.safeParse(input);
      if (!parsed.success) {
        const issues = docIssues(input);
        // docIssues covers every part agents write; the fallback still says where the problem is.
        const fallback = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "doc"}: ${i.message}`);
        return error(`The document isn't valid yet. Fix these and call canvas_create again:\n- ${(issues.length ? issues : fallback).join("\n- ")}`);
      }
      const problems = semanticErrors(parsed.data);
      if (problems.length > 0) return error(`The document isn't valid yet:\n- ${problems.join("\n- ")}`);
      if (store.exists(parsed.data.id) && !replace) {
        const existing = store.get(parsed.data.id);
        return error(
          `A document called "${existing.id}" already exists (rev ${existing.revision}). Change it with canvas_patch, read it with canvas_outline, ` +
            `use a different id, or pass replace: true to start it over.`,
        );
      }
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
        store.save(patch.doc);
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
    "artboard_create",
    {
      description:
        "Add an artboard: blank, or adapted from an existing one (\"from\"). Adapting re-places every layer for the new size: layers keep to the edge they sit against or stay centred, sizes and type scale evenly, and full-width or full-height layers (backgrounds, bands) stretch. Returns the new artboard's outline, render warnings and a preview; adjust with canvas_patch.",
      inputSchema: {
        doc: docId,
        id: z.string().describe('New artboard ID, e.g. "story-9x16"'),
        preset: z.string().optional().describe(`A named size: ${presetList()}`),
        size: z.tuple([z.number().positive(), z.number().positive()]).optional().describe("[width, height] in pixels, instead of a preset"),
        from: z.string().optional().describe("Artboard ID to adapt from. Left out, the new artboard starts empty"),
        name: z.string().optional(),
        scale: z.number().positive().optional().describe("Override the scale for sizes and type; default is the smaller axis ratio"),
        background: z.string().optional().describe('Colour for a blank artboard, e.g. "#FFFFFF"'),
      },
    },
    async ({ doc, id, preset, size, from, name, scale, background }) =>
      guard(async () => {
        const history = store.history(doc);
        const head = history.head;
        if (head.artboards.some((a) => a.id === id)) return error(`Artboard "${id}" already exists. Pick another id, or change it with canvas_patch.`);
        const named = preset ? PRESETS[preset] : undefined;
        if (preset && !named) return error(`Unknown preset "${preset}". Presets: ${presetList()}. Or pass size: [w, h].`);
        const [w, h] = size ?? (named ? [named.w, named.h] : []);
        if (!w || !h) return error("artboard_create needs a preset or a size: [width, height].");
        const source = from ? head.artboards.find((a) => a.id === from) : undefined;
        if (from && !source) return error(`No artboard "${from}". Artboards: ${head.artboards.map((a) => a.id).join(", ")}`);

        // New artboards go to the right of the others, as in Photoshop.
        const right = Math.max(...head.artboards.map((a) => a.frame.x + a.frame.w));
        const reflowed = source ? reflowArtboard(source, { w, h }, { scale }) : undefined;
        const artboard = {
          id,
          name: name ?? named?.name ?? `${w}×${h}`,
          frame: { x: right + 200, y: 0, w, h },
          ...(preset ? { preset } : {}),
          ...(background ? { background } : source?.background ? { background: source.background } : {}),
          ...(source?.meta ? { meta: source.meta } : {}),
          layers: reflowed?.layers ?? [],
        };
        const result = history.apply({ doc, baseRevision: head.revision, ops: [{ op: "artboard", id, artboard }] }, author);
        if (isConflict(result)) return error("The document changed meanwhile; try again.");
        store.save(doc);

        const tree = outline({ ...history.head, artboards: history.head.artboards.filter((a) => a.id === id) });
        const rendered = await renderArtboard(history.head, id, { scale: Math.min(1, 800 / Math.max(w, h)), loader });
        const safe = named?.safe ? `\nSafe zone (keep text and logos inside): top ${named.safe[0]}, right ${named.safe[1]}, bottom ${named.safe[2]}, left ${named.safe[3]} px.` : "";
        const notes = [
          reflowed ? `Adapted from "${from}" at scale ${+reflowed.scale.toFixed(3)}.` : "Empty artboard.",
          ...(source && aspectChange(source.frame, { w, h }) > 2.5
            ? ["Warning: the shape changes a lot, so the layout shrank to fit. Rearrange it with canvas_patch: drop or move secondary layers and enlarge the headline."]
            : []),
          ...rendered.warnings.map((m) => `Warning: ${m}`),
        ].join("\n");
        const response: CallToolResult = {
          content: [
            { type: "text", text: `Revision ${result.revision}. ${notes}${safe}\n${tree}` },
            { type: "image", mimeType: "image/png", data: (await encode(rendered, "png")).toString("base64") },
          ],
        };
        return withCard(response, {
          kind: "patch",
          doc,
          revision: result.revision,
          changed: result.changed,
          warnings: rendered.warnings,
          outline: tree,
          previews: [{ artboard: id, width: rendered.width, height: rendered.height }],
        });
      }),
  );

  register(
    "gen_prepare",
    {
      description:
        "Prepare an image-generation job for a layer: expand (outpaint an image to fill its frame without cropping), generate (a new image for a layer's frame from a prompt), remove-background, or upscale. Gesso doesn't generate images: it writes the source, padded canvas and mask to the Gesso folder and returns sizes, a prompt, the asset id to import the result under, and the canvas_patch ops that place it as a new layer with provenance. Run the job with an image tool the user has connected.",
      inputSchema: {
        doc: docId,
        job: z.enum(["expand", "generate", "remove-background", "upscale"]),
        artboard: z.string().describe("Artboard ID"),
        layer: z.string().describe("Layer ID: the image layer to work on, or for generate the layer whose frame the new image fills"),
        prompt: z.string().optional().describe("What to generate; expand has a sensible default"),
        factor: z.number().int().min(2).max(8).optional().describe("Upscale factor, default 2"),
      },
    },
    async ({ doc, job, ...request }) =>
      guard(async () => json(await prepareJob(store.get(doc), { kind: job, ...request }, baseDir, loader))),
  );

  register(
    "skill_read",
    {
      description: `Read a Gesso recipe: the workflow, judgement calls and checks for a kind of task. Skills: ${skills.map((s) => `${s.name}: ${s.description}`).join(" | ") || "none"}`,
      inputSchema: { name: z.string().describe("Skill name") },
    },
    async ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      return skill ? text(skill.body) : error(`No skill "${name}". Skills: ${skills.map((s) => s.name).join(", ")}`);
    },
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
          store.save(doc);
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

  return server;
}
