// Gesso's identity in agent hosts: the server's display name, logo and website,
// and human titles for each tool, so hosts can show "Gesso · Render preview"
// instead of a bare function name.

/** Interim mark until the wordmark SVG lands: two stacked layers in the brand orange. Brand colours: orange #FF4F1A (main), blue #2440E6, yellow #FFC21A. */
export const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect width="64" height="64" rx="14" fill="#12141a"/>' +
  '<rect x="13" y="23" width="28" height="28" rx="4" fill="#FF4F1A"/>' +
  '<rect x="23" y="13" width="28" height="28" rx="4" fill="none" stroke="#ffffff" stroke-width="3.5"/>' +
  "</svg>";

export const LOGO_DATA_URI = `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG).toString("base64")}`;

export const ICONS = [{ src: LOGO_DATA_URI, mimeType: "image/svg+xml", sizes: ["any"] }];

export const TOOL_TITLES: Record<string, string> = {
  canvas_create: "Create document",
  canvas_outline: "Read outline",
  canvas_get: "Read layers",
  canvas_selection: "Selection",
  canvas_patch: "Edit layers",
  canvas_render: "Render preview",
  artboard_create: "Add artboard",
  canvas_export: "Export",
  asset_import: "Import asset",
  canvas_history: "History",
  gen_prepare: "Prepare generation",
};
