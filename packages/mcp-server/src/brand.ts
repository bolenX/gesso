import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Gesso's identity in agent hosts: the server's display name, logo and website,
// and human titles for each tool, so hosts can show "Gesso · Render preview"
// instead of a bare function name.

const asset = (name: string) => readFileSync(fileURLToPath(new URL(`../assets/${name}`, import.meta.url)), "utf8");

/**
 * The G tile, animated: a sheen sweeps the tile, then the G wipes out and back like a primer stroke.
 * Its resting frame is the plain tile, so hosts that rasterize icons, and reduced motion, show the static logo.
 */
export const FAVICON_SVG = asset("favicon-loop.svg");

/** The GESSO wordmark, animated: letters lift out and rise back in. Fills with currentColor to follow the theme. */
export const WORDMARK_SVG = asset("logo-loop.svg");

export const LOGO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(FAVICON_SVG).toString("base64")}`;

export const ICONS = [{ src: LOGO_DATA_URI, mimeType: "image/svg+xml", sizes: ["any"] }];

export const TOOL_TITLES: Record<string, string> = {
  canvas_list: "List documents",
  canvas_create: "Create document",
  canvas_outline: "Read outline",
  canvas_get: "Read layers",
  canvas_selection: "Selection",
  canvas_patch: "Edit layers",
  canvas_render: "Render preview",
  artboard_create: "Add artboard",
  canvas_export: "Export",
  font_list: "Find fonts",
  skill_read: "Read skill",
  asset_import: "Import asset",
  canvas_history: "History",
  gen_prepare: "Prepare generation",
};
