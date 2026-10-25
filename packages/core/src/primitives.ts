import { z } from "zod";

// Small shared schemas, kept apart so schema.ts and filters.ts can both use them.

/** The 16 standard W3C/PDF blend modes Skia provides. Photoshop-only modes arrive in v0.2. */
export const BlendMode = z.enum([
  "normal",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);
export type BlendMode = z.infer<typeof BlendMode>;

export const Color = z.string().regex(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i, "Colours are #RRGGBB or #RRGGBBAA");

