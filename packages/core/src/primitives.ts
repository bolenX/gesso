import { z } from "zod";

// Small shared schemas, kept apart so schema.ts and filters.ts can both use them.

/** The 16 standard W3C/PDF blend modes, which Skia, CSS and PDF all have. */
export const STANDARD_BLENDS = [
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
] as const;

/** Photoshop's blend modes: the standard ones plus dissolve, linear burn and dodge, vivid, linear and pin light, hard mix, darker and lighter colour, subtract and divide. */
export const BlendMode = z.enum([
  ...STANDARD_BLENDS,
  "dissolve",
  "linear-burn",
  "darker-color",
  "linear-dodge",
  "lighter-color",
  "vivid-light",
  "linear-light",
  "pin-light",
  "hard-mix",
  "subtract",
  "divide",
]);
export type BlendMode = z.infer<typeof BlendMode>;
export const isStandardBlend = (blend: BlendMode | undefined) => (STANDARD_BLENDS as readonly string[]).includes(blend ?? "normal");

export const Color = z.string().regex(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i, "Colours are #RRGGBB or #RRGGBBAA");

