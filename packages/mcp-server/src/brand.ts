import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Gesso's identity in agent hosts: the server's display name, logo and website,
// and human titles for each tool, so hosts can show "Gesso · Render preview"
// instead of a bare function name.

const assetBytes = (name: string) => readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)));
const asset = (name: string) => assetBytes(name).toString("utf8");

/**
 * The G tile, animated: a sheen sweeps the tile, then the G wipes out and back like a primer stroke.
 * Its resting frame is the plain tile, so hosts that rasterize icons, and reduced motion, show the static logo.
 */
export const FAVICON_SVG = asset("favicon-loop.svg");

/** The GESSO wordmark, animated: letters lift out and rise back in. Fills with currentColor to follow the theme. */
export const WORDMARK_SVG = asset("logo-loop.svg");

/**
 * The app icon hosts show next to Gesso (connector lists, extension settings): the G on a plain square that fills
 * the whole image. Hosts round or mask icons themselves, and often on a white plate, so a pre-rounded tile would
 * show white in its corners; it's also still, as icons in a list should be.
 */
export const ICON_SVG = asset("icon.svg");
export const ICON_PNG = assetBytes("icon-256.png");

export const ICONS = [
  { src: `data:image/svg+xml;base64,${Buffer.from(ICON_SVG).toString("base64")}`, mimeType: "image/svg+xml", sizes: ["any"] },
  { src: `data:image/png;base64,${ICON_PNG.toString("base64")}`, mimeType: "image/png", sizes: ["256x256"] },
];

export const TOOL_TITLES: Record<string, string> = {
  canvas_list: "List documents",
  canvas_create: "Create document",
  canvas_outline: "Read outline",
  canvas_get: "Read layers",
  canvas_selection: "Selection",
  canvas_patch: "Edit layers",
  canvas_render: "Render preview",
  canvas_inspect: "Inspect",
  artboard_create: "Add artboard",
  canvas_export: "Export",
  font_list: "Find fonts",
  psd_import: "Open PSD",
  skill_read: "Read skill",
  skill_apply: "Apply recipe",
  asset_import: "Import asset",
  canvas_history: "History",
  gen_prepare: "Prepare AI job",
  canvas_stamp: "Merge layers",
  canvas_batch: "Batch export",
  canvas_align: "Auto-align",
  canvas_stack: "Auto-blend",
};

const READS = { readOnlyHint: true, openWorldHint: false } as const;
/** Creates something new (a document, a job folder) or sets the selection, without changing what's there. */
const CREATES = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
/** Changes an existing document, or writes files that can replace earlier ones. */
const CHANGES = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

/** MCP tool hints, which hosts use for permissions: read-only tools can run without asking, changes ask. */
export const TOOL_HINTS: Record<string, { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean }> = {
  canvas_list: READS,
  canvas_outline: READS,
  canvas_get: READS,
  canvas_render: READS,
  canvas_inspect: READS,
  font_list: READS,
  skill_read: READS,
  canvas_create: CREATES,
  psd_import: CREATES,
  gen_prepare: CREATES,
  canvas_selection: { ...CREATES, idempotentHint: true },
  canvas_patch: CHANGES,
  canvas_history: CHANGES,
  artboard_create: CHANGES,
  canvas_stamp: CHANGES,
  skill_apply: CHANGES,
  canvas_align: CHANGES,
  canvas_stack: CHANGES,
  canvas_export: CHANGES,
  canvas_batch: CHANGES,
  // Downloads from the web when given a URL.
  asset_import: { ...CHANGES, openWorldHint: true },
};
