import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Doc, docIssues, GENERATOR, type Op, GESSO_URL, GESSO_VERSION, isConflict, normalizeDoc, outline, Patch, PRESETS, presetList, reflowArtboard, select, semanticErrors, xmpPacket } from "@gesso/core";
import {
  clippingMap,
  cropRendered,
  matteMap,
  matteReport,
  defaultAssetLoader,
  difference,
  encode,
  fontUri,
  measure,
  renderArtboard,
  renderDoc,
  sampleAt,
  scanFonts,
  sharpnessMap,
  sideBySide,
  softProof,
  systemFontDirs,
  writePdf,
  writeSvg,
  zoomRendered,
  type AssetLoader,
  type ColorOptions,
  type EncodeFormat,
  type InstalledFont,
  type Region,
  type Rendered,
} from "@gesso/render";
import { importPsd, writePsd } from "@gesso/psd";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { ICONS, TOOL_HINTS, TOOL_TITLES } from "./brand.js";
import { DOC_FORMAT } from "./format.js";
import { prepareJob } from "./gen.js";
import { importAsset } from "./import.js";
import { loadSkills } from "./skills.js";
import { describeRecipes, instantiate } from "./recipes.js";
import { preflight } from "./preflight.js";
import { findSlices, renderSlice } from "./slices.js";
import { batch, hideLayers, only, stamp } from "./production.js";
import { alignLayers, stackLayers } from "./merge.js";
import { DocStore } from "./store.js";
import { download, inside, resolvePath } from "./paths.js";
import { FILE_TOOL, WIDGET_MIME, WIDGET_URI, widgetHtml } from "./widget.js";

export { FILE_TOOL };

export { DocStore };

// The v0.1 tool surface. See docs/spec-v0.1.md, "Agent interface".
export const TOOL_NAMES = [
  "canvas_list",
  "canvas_create",
  "psd_import",
  "canvas_outline",
  "canvas_get",
  "canvas_selection",
  "canvas_patch",
  "canvas_render",
  "canvas_inspect",
  "artboard_create",
  "canvas_export",
  "font_list",
  "skill_read",
  "skill_apply",
  "asset_import",
  "canvas_history",
  "gen_prepare",
  "canvas_stamp",
  "canvas_batch",
  "canvas_align",
  "canvas_stack",
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
/**
 * Rewrites a shared server's own folders out of text: paths in the workspace become relative to it (they're what
 * tools take anyway), and the home folder becomes ~. Without it, results would show the server's user name and the
 * workspace's folder, which is its key.
 */
export function scrubber(baseDir: string): (s: string) => string {
  const dir = resolve(baseDir);
  const home = homedir();
  return (s) => {
    const out = s.split(`${dir}${sep}`).join("").split(dir).join(".");
    return home.length > 1 ? out.split(home).join("~") : out;
  };
}

/** Applies a rewrite to every string in a tool result, leaving image and file data alone. */
export function scrubValue<T>(value: T, fix: (s: string) => string): T {
  if (typeof value === "string") return fix(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, fix)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === "data" || k === "blob" ? v : scrubValue(v, fix)])) as T;
  return value;
}

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

/** One deliverable on the export card. Thumbnails are small PNGs; the file itself is fetched on download, or from url on a hosted server. */
type CardFile = { name: string; path: string; kind: string; mimeType: string; bytes: number; url?: string };

const MIME: Record<string, string> = {
  ".psd": "image/vnd.adobe.photoshop",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".tif": "image/tiff",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".json": "application/json",
};


const withCard = (result: CallToolResult, card: CardData): CallToolResult => ({
  ...result,
  structuredContent: { gesso: { ...card, generator: GENERATOR } },
});

export type ServerOptions = {
  /** How long canvas_export waits before answering that the export continues in the background. */
  exportWaitMs?: number;
  /** Defaults to a store that saves documents under baseDir/.gesso. */
  store?: DocStore;
  author?: string;
  /** Where relative asset paths and export directories resolve. */
  baseDir?: string;
  loader?: AssetLoader;
  /** Hosted: tool paths must stay inside baseDir, and downloads must reach public addresses. */
  confined?: boolean;
  /** A public link to a file in baseDir, when the server is hosted; added to exports and jobs. */
  fileUrl?: (path: string) => string | undefined;
  /** Largest artboard area, in pixels at the requested scale, that renders and exports accept. */
  maxPixels?: number;
  /** State shared by servers that serve one workspace, when each request gets its own server (HTTP). */
  state?: ServerState;
  /** Hosted: a page where the user can upload files into this workspace. */
  uploadUrl?: string;
  /** Tools this server leaves out, e.g. gen_prepare on a server listed where AI-generation tools aren't allowed. */
  disabledTools?: ReadonlySet<string>;
};

/** Exports still running, files this workspace exported (the only ones the download tool serves), and recent full renders. */
export type ServerState = { exports: Map<string, Promise<CallToolResult>>; exported: Set<string>; renders: Map<string, Promise<Rendered>> };

export const newServerState = (): ServerState => ({ exports: new Map(), exported: new Set(), renders: new Map() });

/** Reads only the workspace and the system font folders, and downloads only from public addresses. */
export const confinedLoader = (baseDir: string): AssetLoader => {
  const roots = [baseDir, ...systemFontDirs()];
  return defaultAssetLoader(baseDir, { allow: (path) => roots.some((root) => inside(root, path)), download: async (url) => (await download(url, true)).bytes });
};

export function createServer({
  author = "agent",
  baseDir = process.cwd(),
  store = new DocStore(baseDir),
  confined = false,
  loader = confined ? confinedLoader(baseDir) : defaultAssetLoader(baseDir),
  exportWaitMs = 45_000,
  fileUrl,
  maxPixels,
  state = newServerState(),
  uploadUrl,
  disabledTools,
}: ServerOptions = {}): McpServer {
  const { exports, exported } = state;
  const scrub = confined ? scrubber(baseDir) : undefined;
  /** Refuses renders bigger than maxPixels, so one request can't exhaust a shared server's memory. */
  const checkSize = (d: Doc, scale: number, artboard?: string) => {
    if (!maxPixels) return;
    for (const a of d.artboards) {
      if (artboard && a.id !== artboard) continue;
      const pixels = a.frame.w * a.frame.h * scale * scale;
      if (pixels > maxPixels) throw new Error(`Artboard "${a.id}" at scale ${scale} is ${Math.round(pixels / 1e6)} megapixels; this server renders up to ${Math.round(maxPixels / 1e6)}. Use a smaller scale or artboard.`);
    }
  };
  const skills = loadSkills();
  const server = new McpServer(
    { name: "gesso", title: "Gesso", version: GESSO_VERSION, websiteUrl: GESSO_URL, icons: ICONS },
    {
      instructions: [
        "Gesso builds layered images as data and exports PSDs that stay editable in Photoshop.",
        "Read documents with canvas_outline, change them only with canvas_patch, and check your work with canvas_render before finishing: zoom into regions at 100–200% for detail, compare with earlier revisions, and measure tones and colours with canvas_inspect.",
        ...(uploadUrl ? [`Files live in a private workspace on this server. The user can upload images, fonts and PSDs at ${uploadUrl} (the link works for a day), then give asset_import the path, such as uploads/photo.jpg. asset_import also takes a URL or base64 data.`] : []),
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
    // The card loads nothing from the web: images arrive as data, files through the card-only tool.
    async () => ({ contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml(), _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } } }] }),
  );

  // Every tool gets a human title and hints for the host's permissions; the tools that produce something also
  // open the result card.

  const CARD_TOOLS = new Set(["canvas_create", "psd_import", "canvas_patch", "canvas_render", "canvas_export"]);
  const register: typeof server.registerTool = (name, config, cb) => {
    // Hosted: every result, warnings and errors included, goes out without the server's own paths.
    const run = scrub ? async (...args: unknown[]) => scrubValue(await (cb as (...a: unknown[]) => unknown)(...args), scrub) : cb;
    const tool = server.registerTool(
      name,
      {
        title: TOOL_TITLES[name] ?? name,
        annotations: { title: TOOL_TITLES[name] ?? name, ...TOOL_HINTS[name] },
        ...config,
        ...(CARD_TOOLS.has(name) ? { _meta: { ui: { resourceUri: WIDGET_URI }, "ui/resourceUri": WIDGET_URI } } : {}),
      },
      run as typeof cb,
    );
    if (disabledTools?.has(name)) tool.disable();
    return tool;
  };

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
            uri: fontUri(f.path, baseDir, confined),
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
        "Add an image, font or colour lookup table (.cube LUT) to a document's assets from a path, a URL or base64 data. Reads the image size, or the font's family and PostScript name, and returns the entry. Downloads and pasted data are saved in the Gesso folder under assets/. Use the id in image layers (\"asset\"), filters (displacement maps, Match Color sources) and color-lookup adjustments (\"lut\"), or the family in text styles (\"font\").",
      inputSchema: {
        doc: docId,
        id: z.string().describe('Asset ID to use in layers, e.g. "hero-photo"'),
        source: z.string().optional().describe("Path (relative to the Gesso folder, or absolute) or http(s) URL"),
        data: z.string().optional().describe("Base64 file contents, when there's no path or URL"),
        kind: z.enum(["image", "font", "mask", "lut"]).optional().describe('Detected from the file when left out. "mask" saves a grey mask for raster masks: from a cut-out\'s transparency, or a black-and-white image\'s brightness. "lut" is a .cube colour lookup table for a color-lookup adjustment'),
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
        const asset = await importAsset(request, baseDir, confined, uploadUrl);
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
    "psd_import",
    {
      description:
        "Open a Photoshop file as a Gesso document you can edit with canvas_patch. Artboards, groups, text (with mixed styling), shapes, smart objects, adjustments, masks and effects stay editable; pixel layers become images saved in the Gesso folder under imported/. Returns the outline and anything that couldn't be kept.",
      inputSchema: {
        path: z.string().describe("The .psd file: relative to the Gesso folder, or absolute"),
        id: z.string().optional().describe("Document ID; defaults to the file name"),
        replace: z.boolean().optional().describe("Replace an existing document with this id"),
      },
    },
    async ({ path, id, replace }) =>
      guard(async () => {
        const file = resolvePath(baseDir, path, confined);
        if (!existsSync(file)) return error(confined ? `No file "${path}" in your workspace. Upload it first.` : `No file at ${file}`);
        const docId = (id ?? basename(file).replace(/\.ps[db]$/i, "")).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "imported";
        if (store.exists(docId) && !replace) return error(`A document called "${docId}" already exists. Pass another id, or replace: true.`);
        const fonts = await installedFonts();
        const { doc, warnings } = await importPsd(await readFile(file), {
          id: docId,
          assetDir: join(baseDir, "imported", docId),
          uriBase: `imported/${docId}`,
          findFont: async (ps) => {
            const f = fonts.find((x) => x.postscriptName === ps);
            return f ? { uri: fontUri(f.path, baseDir, confined), family: f.fullName, ...(f.face ? { face: f.face } : {}) } : undefined;
          },
        });
        const parsed = Doc.safeParse(doc);
        if (!parsed.success) return error(`The PSD converted to an invalid document: ${docIssues(doc).slice(0, 10).join("; ")}`);
        store.put(parsed.data, author);
        const tree = outline(parsed.data);
        const notes = warnings.length ? `\n\nNot kept exactly:\n- ${warnings.join("\n- ")}` : "";
        return withCard(text(tree + notes), { kind: "create", doc: docId, revision: 0, outline: tree, warnings });
      }),
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
      description:
        "Apply atomic, ID-addressed operations against a baseRevision: set (a field by dot path; lists take an index or + to append, e.g. \"filters.+\" adds a filter and \"filters.0.radius\" tunes one), insert, move, remove, duplicate (Copy/Paste and Duplicate Layer: a copy with a new id, optionally offset or placed elsewhere), replace-text (Find and Replace Text across text layers, plain or regex, keeping styled runs), asset and artboard.",
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
          checkSize(history.head, patch.returnPreview);
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
        "Prepare an image-model job for a layer: expand (outpaint an image to fill its frame without cropping; with artboards, one shared plate for every size), generate (a new image for a layer's frame from a prompt), fill (Generative Fill or Remove in regions of an image layer, with or without a prompt), segment (Select Subject, Select Sky, or face parts like skin, eyes and lips, returned as masks that follow the photo), remove-background, or upscale. Gesso doesn't run models: it writes the source, padded canvas and mask to the Gesso folder and returns sizes, a prompt, the asset ids to import the results under, and the canvas_patch ops that place them with provenance. Run the job with an image tool the user has connected.",
      inputSchema: {
        doc: docId,
        job: z.enum(["expand", "generate", "remove-background", "upscale", "fill", "segment"]),
        artboard: z.string().describe("Artboard ID"),
        layer: z.string().describe("Layer ID: the image layer to work on, or for generate the layer whose frame the new image fills"),
        prompt: z.string().optional().describe("What to generate; expand has a sensible default"),
        factor: z.number().int().min(2).max(8).optional().describe("Upscale factor, default 2"),
        regions: z
          .array(z.object({ at: z.tuple([z.number(), z.number()]), size: z.tuple([z.number(), z.number()]), shape: z.enum(["ellipse", "rect"]).optional() }))
          .optional()
          .describe("fill: where to fill, as centre and size fractions of the layer's box"),
        artboards: z.array(z.string()).max(32).optional().describe("expand: more artboards with the same image layer (same id, as adapted sizes have), all covered by one generated plate"),
        targets: z
          .array(z.string().min(1).max(80))
          .min(1)
          .max(12)
          .optional()
          .describe('segment: what to select, one mask each: subject, person, sky, background, skin, face, hair, eyes, brows, lips, teeth, clothes, or a short description like "the red car"'),
        onto: z.string().optional().describe("segment: a layer to mask with the first target right away: the photo itself (a cut-out), or an adjustment or group above it"),
        invert: z.boolean().optional().describe("segment with onto: mask everything except the target"),
      },
    },
    async ({ doc, job, ...request }) =>
      guard(async () => {
        const prepared = await prepareJob(store.get(doc), { kind: job, ...request }, baseDir, loader, scrub);
        if (!fileUrl) return json(prepared);
        // Hosted: the image tool reads the job's files from their links, not from this server's disk.
        const urls = Object.fromEntries(Object.entries(prepared.files).flatMap(([name, path]) => {
          const url = fileUrl(path);
          return url ? [[name, url]] : [];
        }));
        return json({ ...prepared, urls });
      }),
  );

  register(
    "skill_read",
    {
      description: `Read a Gesso recipe: the workflow, judgement calls and checks for a kind of task. Skills: ${skills.map((s) => `${s.name}: ${s.description}`).join(" | ") || "none"}`,
      inputSchema: { name: z.string().describe("Skill name") },
    },
    async ({ name }) => {
      const skill = skills.find((s) => s.name === name);
      if (!skill) return error(`No skill "${name}". Skills: ${skills.map((s) => s.name).join(", ")}`);
      const parts = [skill.body];
      if (skill.recipes) parts.push(`## Recipes\n\nApply one with skill_apply (skill "${skill.name}"); it adds the layers as one revision you can adjust after.\n\n${describeRecipes(skill.recipes)}`);
      if (skill.checks) parts.push(`## Checks\n\n${skill.checks.replace(/^# .*\n+/, "")}`);
      return text(parts.join("\n\n"));
    },
  );

  register(
    "skill_apply",
    {
      description:
        "Apply a skill's recipe: a proven layer setup (frequency separation, a flambient stack, a duotone, a contact shadow…) filled in with your parameters and applied as one revision. skill_read lists each skill's recipes and their parameters. Then check the result with canvas_render and canvas_inspect, and fine-tune with canvas_patch.",
      inputSchema: {
        doc: docId,
        skill: z.string(),
        recipe: z.string(),
        params: z.record(z.unknown()).default({}).describe("Recipe parameters: layer and artboard ids, numbers, colours"),
        baseRevision: z.number().int().nonnegative().optional().describe("Defaults to the current revision"),
        dryRun: z.boolean().optional().describe("Return the ops without applying them"),
      },
    },
    async ({ doc, skill: skillName, recipe: recipeName, params, baseRevision, dryRun }) =>
      guard(async () => {
        const skill = skills.find((s) => s.name === skillName);
        if (!skill) return error(`No skill "${skillName}". Skills: ${skills.map((s) => s.name).join(", ")}`);
        const recipe = skill.recipes?.recipes[recipeName];
        if (!recipe) {
          const names = Object.keys(skill.recipes?.recipes ?? {});
          return error(names.length ? `No recipe "${recipeName}" in ${skill.name}. Recipes: ${names.join(", ")}` : `${skill.name} has no recipes; follow its steps with canvas_patch`);
        }
        const history = store.history(doc);
        const ops = instantiate(recipe, params, history.head);
        if (dryRun) return json({ ops });
        const result = history.apply(Patch.parse({ doc, baseRevision: baseRevision ?? history.head.revision, ops }), author, { selection: store.selection(doc) });
        if (isConflict(result)) return error(`Stale baseRevision; the document is at revision ${history.head.revision}.`);
        store.save(doc);
        const tree = outline(history.head);
        return withCard(json({ ...result, outline: tree }), { kind: "patch", doc, revision: result.revision, changed: result.changed, warnings: result.warnings, outline: tree });
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
          store.save(doc);
          return json({ revision: reverted.revision, outline: outline(reverted) });
        }
        return json(history.revisions());
      }),
  );

  const Region = z
    .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
    .describe("Part of the artboard, in artboard pixels");

  /** The artboard to work on: the one given, or the only one. */
  const pickArtboard = (d: Doc, artboard?: string) => {
    if (artboard) {
      if (!d.artboards.some((a) => a.id === artboard)) throw new Error(`No artboard "${artboard}". Artboards: ${d.artboards.map((a) => a.id).join(", ")}`);
      return artboard;
    }
    if (d.artboards.length === 1) return d.artboards[0]!.id;
    throw new Error(`Name the artboard: ${d.artboards.map((a) => a.id).join(", ")}`);
  };

  /** Full renders are kept for the last few views, so zooming around one revision doesn't re-render it. */
  const cachedRender = (d: Doc, artboard: string, scale: number, variant = "") => {
    const key = JSON.stringify([d.id, d.revision, artboard, scale, variant]);
    let job = state.renders.get(key);
    if (job) state.renders.delete(key);
    else {
      job = renderArtboard(d, artboard, { scale, loader });
      job.catch(() => state.renders.delete(key));
    }
    state.renders.set(key, job);
    while (state.renders.size > 3) state.renders.delete(state.renders.keys().next().value!);
    return job;
  };

  /**
   * One view of an artboard: whole, or a region zoomed like Photoshop's 100–400% (each pixel a square block).
   * Below 100% the region comes from a render at that scale.
   */
  const renderView = async (d: Doc, artboard: string, scale: number, region?: Region, variant = "") => {
    if (!region) return cachedRender(d, artboard, scale, variant);
    const base = Math.min(1, scale);
    checkSize(d, base, artboard);
    const full = await cachedRender(d, artboard, base, variant);
    const view = cropRendered(full, { x: region.x * base, y: region.y * base, w: region.w * base, h: region.h * base });
    if (view.width * Math.max(1, Math.round(scale)) * view.height * Math.max(1, Math.round(scale)) > 4_200_000) {
      throw new Error(`That view would be over 4 megapixels; use a smaller region or zoom (scale ${scale} × ${Math.round(region.w)}×${Math.round(region.h)})`);
    }
    return scale > 1 ? zoomRendered(view, scale) : view;
  };

  /** The document as it was ("revision") or with some layers hidden ("hide"), to compare against. */
  const before = (doc: string, compare: { revision?: number | undefined; hide?: string[] | undefined }) => {
    const history = store.history(doc);
    if (compare.revision !== undefined) return { doc: history.at(compare.revision), label: `revision ${compare.revision}`, variant: "" };
    if (compare.hide?.length) return { doc: hideLayers(history.head, new Set(compare.hide)), label: `without ${compare.hide.join(", ")}`, variant: `hide:${compare.hide.join(",")}` };
    throw new Error("compare needs a revision or layers to hide");
  };

  register(
    "canvas_render",
    {
      description:
        "Render artboards to preview images. Use a small scale (default 0.5) to save tokens. To check detail, give a region and zoom in (scale 1 = 100%, up to 4 = 400%). To check a change, compare with an earlier revision or with layers hidden: side by side (before left), or a difference image showing where pixels changed, with numbers.",
      inputSchema: {
        doc: docId,
        artboard: z.string().optional().describe("Artboard ID; omit to render every artboard (one is needed with region or compare)"),
        scale: z.number().positive().max(4).default(0.5).describe("0.5 is half size, 1 is 100%. Above 2 needs a region"),
        region: Region.optional(),
        compare: z
          .object({
            revision: z.number().int().nonnegative().optional().describe("Compare with this earlier revision (canvas_history lists them)"),
            hide: z.array(z.string()).optional().describe("Compare with these layers hidden: what they add"),
            view: z.enum(["side-by-side", "difference"]).default("side-by-side"),
          })
          .optional(),
        proof: z
          .string()
          .optional()
          .describe('Soft proof (View › Proof Colors): "cmyk" for a standard press, or the path of a CMYK ICC profile; shows colours as they would print'),
      },
    },
    async ({ doc, artboard, scale, region, compare, proof }) =>
      guard(async () => {
        const d = store.get(doc);
        if (scale > 2 && !region) throw new Error("Scales above 2 need a region: zoom into part of the artboard");
        checkSize(d, region ? Math.min(1, scale) : scale, artboard);
        let rendered: Rendered[];
        let note = "";
        if (region || compare) {
          const id = pickArtboard(d, artboard);
          const after = await renderView(d, id, scale, region);
          if (compare) {
            const b = before(doc, compare);
            const was = await renderView(b.doc, id, scale, region, b.variant);
            const diff = difference(was, after);
            const where = diff.stats.bounds
              ? `; changes within x ${Math.round((region?.x ?? 0) + diff.stats.bounds.x / scale)}, y ${Math.round((region?.y ?? 0) + diff.stats.bounds.y / scale)}, ${Math.round(diff.stats.bounds.w / scale)}×${Math.round(diff.stats.bounds.h / scale)} (artboard px)`
              : "";
            note = `\n${compare.view === "difference" ? "Difference (brighter = more change)" : `Left: ${b.label}. Right: now (revision ${d.revision})`}. ${diff.stats.changed}% of pixels changed, ΔE mean ${diff.stats.deltaE.mean}, max ${diff.stats.deltaE.max}${where}`;
            rendered = [compare.view === "difference" ? diff.image : sideBySide(was, after)];
          } else rendered = [after];
        } else {
          rendered = artboard ? [await renderArtboard(d, artboard, { scale, loader })] : await renderDoc(d, { scale, loader });
        }
        if (proof) rendered = await Promise.all(rendered.map((r) => softProof(r, profilePath(proof))));
        const content: CallToolResult["content"] = [];
        const previews: NonNullable<CardData["previews"]> = [];
        for (const r of rendered) {
          const png = (await encode(r, "png")).toString("base64");
          const at = region ? ` (region ${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.w)}×${Math.round(region.h)} at ${Math.round(scale * 100)}%)` : "";
          content.push({ type: "text", text: `${r.artboard} ${r.width}×${r.height}${at}${note}${r.warnings.map((w) => `\nwarning: ${w}`).join("")}` });
          content.push({ type: "image", mimeType: "image/png", data: png });
          previews.push({ artboard: r.artboard, width: r.width, height: r.height });
        }
        return withCard({ content }, { kind: "render", doc, revision: d.revision, previews, warnings: rendered.flatMap((r) => r.warnings) });
      }),
  );

  register(
    "canvas_inspect",
    {
      description:
        "Measure an artboard (or a region, or some layers alone) at full size, like Photoshop's Histogram and Info panels: tonal range, clipping, contrast, colour cast, saturation, sharpness and noise, plus eyedropper samples (hex, RGB, HSB, Lab, and the vectorscope angle against the skin-tone line). A map shows clipped pixels or where the detail is. Use it to check retouching and grading with numbers, before and after a change. With matte and layers, it checks a cut-out's edge: soft-edge width, halo of the old background, specks and holes.",
      inputSchema: {
        doc: docId,
        artboard: z.string().optional().describe("Needed when the document has several artboards"),
        region: Region.optional(),
        layers: z.array(z.string()).optional().describe("Measure only these layers (and the groups around them), without the background"),
        revision: z.number().int().nonnegative().optional().describe("Measure an earlier revision instead of the current one"),
        samples: z.array(z.tuple([z.number(), z.number()])).max(50).optional().describe("Points to sample, in artboard pixels"),
        sampleSize: z
          .union([z.literal(1), z.literal(3), z.literal(5), z.literal(11), z.literal(31), z.literal(51), z.literal(101)])
          .default(5)
          .describe("Eyedropper sample size: 1 is a point, 5 averages 5×5 pixels"),
        map: z
          .enum(["clipping", "sharpness", "matte"])
          .optional()
          .describe("Also return an image: clipping (red = clipped to white in a channel, blue = clipped to black), sharpness (bright = detailed, dark = soft), or matte (with layers: the cut-out's mask, and the cut-out over black, white and red)"),
        matte: z
          .boolean()
          .optional()
          .describe("With layers: check them as a cut-out. Reports soft-edge width, halo (how far edge colours stray from the subject's own: under 10 clean, over 20 a visible fringe) and its tone, specks of background left behind, and see-through holes inside the subject"),
        preflight: z
          .boolean()
          .optional()
          .describe("Also list layout problems: text and logos in a preset's safe-zone margins or off the artboard, type too small to read, images enlarged past their pixels, hidden or empty layers"),
      },
    },
    async ({ doc, artboard, region, layers, revision, samples, sampleSize, map, matte, preflight: wantPreflight }) =>
      guard(async () => {
        if ((matte || map === "matte") && !layers?.length) return error("A matte check needs layers: the cut-out's layer id, measured alone on transparency.");
        const history = store.history(doc);
        let d = revision === undefined ? history.head : history.at(revision);
        const id = pickArtboard(d, artboard);
        const issues = wantPreflight ? await preflight(d, id) : undefined;
        checkSize(d, 1, id);
        if (layers?.length) d = only(d, id, new Set(layers));
        const full = await cachedRender(d, id, 1, layers?.length ? `only:${layers.join(",")}` : "");
        const view = region ? cropRendered(full, region) : full;
        const origin = region ? [Math.max(0, Math.round(region.x)), Math.max(0, Math.round(region.y))] : [0, 0];
        const result = {
          artboard: id,
          revision: d.revision,
          ...(region ? { region } : {}),
          ...(layers?.length ? { layers } : {}),
          ...measure(view),
          ...(samples?.length ? { samples: samples.map((p) => sampleAt(full, p, sampleSize)) } : {}),
          ...(issues ? { preflight: issues.length ? issues : "no problems found" } : {}),
          ...(matte ? { matte: matteReport(view) } : {}),
        };
        const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(result, null, 1) }];
        if (map) {
          const image = map === "clipping" ? clippingMap(view) : map === "matte" ? matteMap(view) : sharpnessMap(view);
          // Large maps are scaled to fit 1024 px; zoom in with a region for full detail.
          const png = await sharp(await encode(image, "png"))
            .resize(1024, 1024, { fit: "inside", withoutEnlargement: true, kernel: "nearest" })
            .png()
            .toBuffer();
          content.push({ type: "text", text: `${map} map of ${region ? `region at ${origin.join(",")}` : `artboard ${id}`}` });
          content.push({ type: "image", mimeType: "image/png", data: png.toString("base64") });
        }
        return { content };
      }),
  );

  /** Applies ops as one revision, saves, and answers with the result and outline (like canvas_patch). */
  const applyOps = (doc: string, ops: Op[], extra: Record<string, unknown> = {}) => {
    const history = store.history(doc);
    const result = history.apply(Patch.parse({ doc, baseRevision: history.head.revision, ops }), author, { selection: store.selection(doc) });
    if (isConflict(result)) throw new Error("The document changed meanwhile; try again.");
    store.save(doc);
    const tree = outline(history.head);
    return withCard(json({ ...result, ...extra, outline: tree }), { kind: "patch", doc, revision: result.revision, changed: result.changed, warnings: result.warnings, outline: tree });
  };

  register(
    "canvas_align",
    {
      description:
        "Edit › Auto-Align Layers: lines up exposures of the same scene (a focus stack, an exposure bracket, burst frames) with a reference layer, by phase correlation. Shifts each layer's frame, and with scale or rotation also corrects focus breathing (±4%) or a slight handheld turn (±2°). Returns what it found per layer, with a confidence (higher is surer; below about 0.05 the match is doubtful).",
      inputSchema: {
        doc: docId,
        artboard: z.string(),
        reference: z.string().describe("The layer the others line up with (usually the middle exposure or the sharpest frame)"),
        layers: z.array(z.string()).min(1).describe("Layers to move onto the reference"),
        scale: z.boolean().optional().describe("Also correct a scale change (focus breathing between focus-stack frames)"),
        rotation: z.boolean().optional().describe("Also correct a small rotation (handheld frames)"),
      },
    },
    async ({ doc, ...request }) =>
      guard(async () => {
        const d = store.get(doc);
        checkSize(d, 1, request.artboard);
        const { ops, results } = await alignLayers(d, request, loader);
        return applyOps(doc, ops, { aligned: results });
      }),
  );

  register(
    "canvas_stack",
    {
      description:
        "Edit › Auto-Blend Layers: merges aligned exposures into one image with a raster mask per layer. mode focus: a focus stack, each part from the frame where it's sharpest. mode exposure: an exposure bracket fused (Mertens exposure fusion), favouring well-exposed, contrasty, saturated pixels, as a natural-looking HDR. The bottom layer shows everywhere; layers above are masked. Align them first with canvas_align.",
      inputSchema: {
        doc: docId,
        artboard: z.string(),
        layers: z.array(z.string()).min(2).describe("The exposures, all covering the same area"),
        mode: z.enum(["focus", "exposure"]),
        smoothness: z.number().positive().max(200).optional().describe("How soft the transitions between frames are, in px (default 1% of the shorter side)"),
      },
    },
    async ({ doc, ...request }) =>
      guard(async () => {
        const d = store.get(doc);
        checkSize(d, 1, request.artboard);
        const { ops, layers } = await stackLayers(d, request, baseDir, loader);
        return applyOps(doc, ops, { blended: layers });
      }),
  );

  register(
    "canvas_stamp",
    {
      description:
        "Merge layers into one pixel layer: Stamp Visible (everything visible, when no layers are given), Copy Merged and Paste, Merge Layers (merge: true removes the originals) or Rasterize (one layer). Renders them, saves the pixels in the Gesso folder and inserts an image layer above them. Use it for techniques that work on a merged copy: frequency separation, high-pass sharpening, dodge & burn, content-aware fill across layers.",
      inputSchema: {
        doc: docId,
        artboard: z.string(),
        id: z.string().describe("Id for the new layer and its image asset"),
        layers: z.array(z.string()).optional().describe("Layer ids to merge; every visible layer when left out"),
        region: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).optional().describe("Part of the artboard to keep; all of it by default"),
        merge: z.boolean().optional().describe("Remove the merged layers (Merge Layers)"),
      },
    },
    async ({ doc, ...request }) =>
      guard(async () => {
        const history = store.history(doc);
        checkSize(history.head, 1, request.artboard);
        const { ops, warnings } = await stamp(history.head, request, baseDir, loader);
        const result = history.apply({ doc, baseRevision: history.head.revision, ops }, author);
        if (isConflict(result)) return error("The document changed while stamping; try again");
        store.save(doc);
        const tree = outline(history.head);
        return withCard(json({ ...result, warnings: [...result.warnings, ...warnings], outline: tree }), { kind: "patch", doc, revision: result.revision, changed: result.changed, outline: tree });
      }),
  );

  register(
    "canvas_batch",
    {
      description:
        "Run a document as a template over many images or rows of data (Photoshop's File › Automate › Batch and Variables / data sets). With sources (a folder or a list of images) and layer, each image takes that image layer's place (keeping its frame, fit, filters and effects). With rows, each row is a set of values by layer id: text layers take the text, image layers a path; \"name\" names the file. Every artboard is exported per image or row.",
      inputSchema: {
        doc: docId,
        layer: z.string().optional().describe("The image layer id each source image replaces"),
        sources: z.union([z.string(), z.array(z.string())]).optional().describe("A folder of images, or a list of image paths, relative to the Gesso folder"),
        rows: z.array(z.record(z.string())).optional().describe('Data rows, e.g. [{ "name": "spring", "headline": "Spring Sale", "photo": "photos/spring.jpg" }]'),
        outDir: z.string(),
        format: z.enum(["png", "jpeg", "webp", "tiff", "psd"]).default("png"),
        scale: z.number().positive().max(4).default(1),
        color: z.enum(["rgb", "cmyk"]).optional(),
        profile: z.string().optional(),
      },
    },
    async ({ doc, color, profile, ...request }) =>
      guard(async () => {
        const d = store.get(doc);
        checkSize(d, request.scale);
        const { files } = await batch(d, { ...request, color: { ...(color ? { color } : {}), ...(profile ? { profile: profilePath(profile) } : {}) } }, baseDir, loader, confined);
        for (const f of files) exported.add(f.path);
        return json({ doc, revision: d.revision, files: files.map((f) => withUrl(f)) });
      }),
  );

  register(
    "canvas_export",
    {
      description:
        "Export every artboard as an image file; the whole document as one layered PSD with artboards; each artboard as an editable SVG (vector shapes and real text; effects SVG can't express are embedded as images); or a PDF with a page per artboard (vector and selectable text, fonts embedded; for print, set bleed and marks). Writes a manifest.json too.",
      inputSchema: {
        doc: docId,
        outDir: z.string().describe("Directory to write into, relative to the server's base directory"),
        format: z.enum(["png", "jpeg", "webp", "tiff", "psd", "svg", "pdf"]).default("png"),
        scale: z.number().positive().max(4).default(1).describe("Ignored for PSD, which is always full size"),
        images: z.boolean().default(true).describe("With format psd, svg or pdf, also write a flat PNG of each artboard"),
        dpi: z.number().positive().optional().describe("PDF: pixels per inch for the page size; default 300 for print presets (A4, Letter…), else 72"),
        bleed: z.number().min(0).max(20).optional().describe("PDF: bleed in mm on every side (3 is standard); layers touching the edge extend into it"),
        marks: z.boolean().optional().describe("PDF: add crop marks"),
        color: z.enum(["rgb", "cmyk"]).optional().describe("Image colour: rgb (default) or cmyk for print (jpeg and tiff), converted through the profile"),
        profile: z
          .string()
          .optional()
          .describe('ICC profile to convert into and embed (Convert to Profile): "srgb", "p3", "cmyk" (a standard press), or a path to an .icc/.icm file'),
        slices: z
          .boolean()
          .optional()
          .describe('Also export each layer named like a file ("logo.png", "200% hero.jpg", "hero.jpg80", "512x512 icon.png"), alone and cropped, as Photoshop\'s Generate › Image Assets does'),
      },
    },
    async ({ doc, outDir, format, scale, images, dpi, bleed, marks, color, profile, slices }, extra) =>
      guard(async () => {
        const d = store.get(doc);
        checkSize(d, format === "psd" ? 1 : scale);
        const dir = resolvePath(baseDir, outDir, confined);
        // Large documents can take longer than an agent waits for one tool call. The export keeps
        // running in the background; calling again with the same arguments picks up the result.
        const key = JSON.stringify([d.id, d.revision, dir, format, scale, images, dpi, bleed, marks, color, profile, slices]);
        let job = exports.get(key);
        if (!job) {
          job = runExport(d, dir, format, scale, images, { dpi, bleed, marks }, { ...(color ? { color } : {}), ...(profile ? { profile: profilePath(profile) } : {}) }, slices ?? false);
          exports.set(key, job);
          job.then(
            () => setTimeout(() => exports.delete(key), 10 * 60_000).unref(),
            () => exports.delete(key),
          );
        }
        const progressToken = extra?._meta?.progressToken;
        const started = Date.now();
        const heartbeat = progressToken
          ? setInterval(() => {
              void extra.sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress: Math.round((Date.now() - started) / 1000), message: `Exporting ${d.id}…` },
              });
            }, 5000)
          : undefined;
        try {
          const done = await Promise.race([job, new Promise<undefined>((r) => setTimeout(() => r(undefined), exportWaitMs).unref())]);
          if (!done) {
            return text(
              `Still exporting "${d.id}" (a large document); it carries on in the background and writes to ${dir}. Call canvas_export again with the same arguments in a minute to get the files.`,
            );
          }
          exports.delete(key);
          return done;
        } finally {
          if (heartbeat) clearInterval(heartbeat);
        }
      }),
  );

  /** A profile name stays a built-in name; anything else is a path relative to the Gesso folder. */
  const profilePath = (profile: string) => (["srgb", "p3", "cmyk"].includes(profile) ? profile : resolvePath(baseDir, profile, confined));

  /** Adds the file's public link, when the server is hosted. */
  const withUrl = <T extends { path: string }>(file: T): T & { url?: string } => {
    const url = fileUrl?.(file.path);
    return url ? { ...file, url } : file;
  };

  async function runExport(
    d: Doc,
    dir: string,
    format: "png" | "jpeg" | "webp" | "tiff" | "psd" | "svg" | "pdf",
    scale: number,
    images: boolean,
    print: { dpi?: number; bleed?: number; marks?: boolean } = {},
    color: ColorOptions = {},
    slices = false,
  ): Promise<CallToolResult> {
    if (color.color === "cmyk" && format !== "jpeg" && format !== "tiff") throw new Error("CMYK export needs format jpeg or tiff (PSD and PDF stay RGB)");
    await mkdir(dir, { recursive: true });
    const xmp = xmpPacket(d.id, d.revision);
    const files = [];
    let flats: Awaited<ReturnType<typeof renderDoc>> | undefined;
    if (format === "pdf") {
      const { bytes, warnings } = await writePdf(d, { loader, ...print });
      const path = resolve(dir, `${d.id}.pdf`);
      await writeFile(path, bytes);
      files.push({ artboards: d.artboards.map((a) => a.id), path, warnings });
    }
    if (format === "svg") {
      for (const artboard of d.artboards) {
        const { svg, warnings } = await writeSvg(d, artboard.id, { loader });
        const path = resolve(dir, `${artboard.id}.svg`);
        await writeFile(path, svg);
        files.push({ artboard: artboard.id, path, width: artboard.frame.w, height: artboard.frame.h, warnings });
      }
    }
    if (format === "psd") {
      const result = await writePsd(d, { loader });
      const path = resolve(dir, `${d.id}.psd`);
      await writeFile(path, result.bytes);
      files.push({ artboards: d.artboards.map((a) => a.id), path, warnings: result.warnings });
      flats = result.flats;
    }
    // PSD and SVG exports also write a flat PNG of each artboard unless images is false.
    const imageFormat = format === "psd" || format === "svg" || format === "pdf" ? (images ? "png" : undefined) : format;
    if (imageFormat) {
      const ext = imageFormat === "jpeg" ? "jpg" : imageFormat === "tiff" ? "tif" : imageFormat;
      for (const r of flats ?? (await renderDoc(d, { scale, loader }))) {
        const path = resolve(dir, `${r.artboard}.${ext}`);
        await writeFile(path, await encode(r, imageFormat as EncodeFormat, 90, xmp, imageFormat === format ? color : {}));
        files.push({ artboard: r.artboard, path, width: r.width, height: r.height, warnings: r.warnings });
      }
    }
    if (slices) {
      const found = findSlices(d);
      if (!found.length) throw new Error('No layers are named like files ("logo.png", "200% hero.jpg"); rename the layers to export as slices');
      await mkdir(resolve(dir, "assets"), { recursive: true });
      for (const slice of found) {
        const { bytes, width, height, warnings } = await renderSlice(d, { ...slice, scale: slice.scale * scale }, loader, slice.format === "jpeg" || slice.format === "tiff" ? color : {});
        const path = resolve(dir, "assets", slice.file);
        await writeFile(path, bytes);
        files.push({ artboard: slice.artboard, layer: slice.layer, path, width, height, warnings });
      }
    }
    const manifestPath = resolve(dir, "manifest.json");
    const manifest = { generator: GENERATOR, doc: d.id, revision: d.revision, exportedAt: new Date().toISOString(), format, scale, files };
    await writeFile(manifestPath, JSON.stringify(scrub ? scrubValue(manifest, scrub) : manifest, null, 2));

    const cardFiles: CardFile[] = [];
    for (const f of [...files, { path: manifestPath }]) {
      exported.add(f.path);
      const ext = extname(f.path).toLowerCase();
      const url = fileUrl?.(f.path);
      cardFiles.push({
        name: basename(f.path),
        path: f.path,
        kind: ext.slice(1).toUpperCase().replace("JPG", "JPEG"),
        mimeType: MIME[ext] ?? "application/octet-stream",
        bytes: (await stat(f.path)).size,
        // Some hosts give the model only this structured part, so the links must be here too.
        ...(url ? { url } : {}),
      });
    }
    const manifestUrl = fileUrl?.(manifestPath);
    return withCard(json({ ...manifest, files: files.map(withUrl), ...(manifestUrl ? { manifestUrl } : {}) }), {
      kind: "export",
      doc: d.id,
      revision: d.revision,
      files: cardFiles,
      warnings: files.flatMap((f) => ("warnings" in f ? f.warnings : [])),
    });
  }

  server.registerTool(
    FILE_TOOL,
    {
      title: "Download file",
      annotations: { title: "Download file", readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      description: "Returns a file this Gesso server exported, for the result card's download buttons.",
      inputSchema: { path: z.string(), maxSize: z.number().int().positive().max(2048).optional().describe("Return images scaled to fit this many pixels, as PNG") },
      _meta: { ui: { visibility: ["app"] } },
    },
    async ({ path: asked, maxSize }) =>
      guard(async () => {
        // Hosted cards list files relative to the workspace.
        const path = resolvePath(baseDir, asked, confined);
        if (!exported.has(path)) return error("Only files exported in this session can be downloaded");
        const ext = extname(path).toLowerCase();
        const scale = maxSize !== undefined && [".png", ".jpg", ".webp"].includes(ext);
        const mimeType = scale ? "image/png" : (MIME[ext] ?? "application/octet-stream");
        const bytes = scale
          ? await sharp(path).resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true }).png().toBuffer()
          : await readFile(path);
        const blob = bytes.toString("base64");
        return {
          content: [{ type: "resource", resource: { uri: fileUrl?.(path) ?? pathToFileURL(path).href, mimeType, blob } }],
          structuredContent: { name: basename(path), mimeType, blob },
        };
      }),
  );

  return server;
}
