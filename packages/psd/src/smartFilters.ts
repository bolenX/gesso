import type { BlendMode, Filter } from "@gesso/core";
import type { Filter as PsdFilter } from "ag-psd";

// Gesso filters as Photoshop smart filters, and back. Only filters whose parameters mean the same thing in
// both are mapped; the rest stay baked into the layer's pixels (with a warning) when written to a PSD.

type Variant = Extract<PsdFilter, { type: string }>;
type Base = "name" | "opacity" | "blendMode" | "enabled" | "hasOptions" | "foregroundColor" | "backgroundColor";
/** One filter's type and parameters, without the smart-filter fields every filter shares. */
type Body = Variant extends infer V ? (V extends unknown ? Omit<V, Base> : never) : never;

const px = (value: number) => ({ units: "Pixels" as const, value });

/** Photoshop's menu names, shown in the Layers panel under Smart Filters. */
const NAMES: Partial<Record<Filter["kind"], string>> = {
  "gaussian-blur": "Gaussian Blur",
  "box-blur": "Box Blur",
  "motion-blur": "Motion Blur",
  "surface-blur": "Surface Blur",
  median: "Median",
  "dust-and-scratches": "Dust & Scratches",
  despeckle: "Despeckle",
  average: "Average",
  blur: "Blur",
  "blur-more": "Blur More",
  sharpen: "Unsharp Mask",
  "sharpen-more": "Sharpen More",
  "sharpen-edges": "Sharpen Edges",
  "high-pass": "High Pass",
  maximum: "Maximum",
  minimum: "Minimum",
  emboss: "Emboss",
  "find-edges": "Find Edges",
  solarize: "Solarize",
  pixelate: "Mosaic",
  twirl: "Twirl",
  pinch: "Pinch",
  spherize: "Spherize",
  "polar-coordinates": "Polar Coordinates",
  offset: "Offset",
};

const EDGES = { wrap: "wrap around", repeat: "repeat edge pixels", transparent: "set to transparent" } as const;

/** The Photoshop body of a filter, or undefined when Photoshop has no exact equivalent. */
function body(f: Filter): Body | undefined {
  switch (f.kind) {
    case "gaussian-blur":
      return { type: "gaussian blur", filter: { radius: px(f.radius) } };
    case "box-blur":
      return { type: "box blur", filter: { radius: px(f.radius) } };
    case "motion-blur":
      return { type: "motion blur", filter: { angle: f.angle, distance: px(f.distance) } };
    case "surface-blur":
      return { type: "surface blur", filter: { radius: px(f.radius), threshold: f.threshold } };
    case "median":
      return { type: "median", filter: { radius: px(f.radius) } };
    case "dust-and-scratches":
      return { type: "dust and scratches", filter: { radius: f.radius, threshold: f.threshold ?? 0 } };
    case "despeckle":
    case "average":
    case "blur":
    case "find-edges":
    case "solarize":
      return { type: f.kind.replace("-", " ") as "despeckle" | "average" | "blur" | "find edges" | "solarize" };
    case "blur-more":
      return { type: "blur more" };
    case "sharpen-more":
      return { type: "sharpen more" };
    case "sharpen-edges":
      return { type: "sharpen edges" };
    case "sharpen":
      return { type: "unsharp mask", filter: { amount: Math.round(f.amount * 100), radius: px(f.radius ?? 1), threshold: f.threshold ?? 0 } };
    case "high-pass":
      return f.scale === undefined || f.scale === 1 ? { type: "high pass", filter: { radius: px(f.radius) } } : undefined;
    case "maximum":
    case "minimum":
      return { type: f.kind, filter: { radius: px(f.radius) } };
    case "emboss":
      return { type: "emboss", filter: { angle: f.angle ?? 135, height: f.height ?? 3, amount: f.amount ?? 100 } };
    case "pixelate":
      return { type: "mosaic", filter: { cellSize: px(f.size) } };
    case "twirl":
      // Photoshop twirls the circle inscribed in the layer, about its centre: Gesso's defaults.
      return f.center === undefined && (f.radius === undefined || f.radius === 0.5) ? { type: "twirl", filter: { angle: f.angle } } : undefined;
    case "pinch":
      return { type: "pinch", filter: { amount: f.amount } };
    case "spherize":
      return { type: "spherize", filter: { amount: f.amount, mode: f.mode === "horizontal" ? "horizontal only" : f.mode === "vertical" ? "vertical only" : "normal" } };
    case "polar-coordinates":
      return { type: "polar coordinates", filter: { conversion: f.mode === "rect-to-polar" ? "rectangular to polar" : "polar to rectangular" } };
    case "offset":
      return { type: "offset", filter: { horizontal: f.x, vertical: f.y, undefinedAreas: EDGES[f.edges ?? "wrap"] } };
    default:
      return undefined;
  }
}

/** A Gesso filter as a Photoshop smart filter, with its Fade (opacity and blend), or undefined when there's no exact match. */
export function toPsdFilter(f: Filter, blend: (b: BlendMode | undefined) => PsdFilter["blendMode"]): PsdFilter | undefined {
  const b = body(f);
  if (!b) return undefined;
  return {
    ...b,
    name: NAMES[f.kind] ?? f.kind,
    opacity: f.opacity ?? 1,
    blendMode: blend(f.blend),
    enabled: true,
    hasOptions: "filter" in b,
    foregroundColor: { r: 0, g: 0, b: 0 },
    backgroundColor: { r: 255, g: 255, b: 255 },
  } as PsdFilter;
}

/** A Photoshop smart filter as a Gesso filter, or undefined when Gesso has no exact match. */
export function fromPsdFilter(f: PsdFilter, blend: (b: PsdFilter["blendMode"]) => BlendMode | undefined): Filter | undefined {
  const fade = { ...(f.opacity < 0.999 ? { opacity: Math.round(f.opacity * 1000) / 1000 } : {}), ...(blend(f.blendMode) && blend(f.blendMode) !== "normal" ? { blend: blend(f.blendMode)! } : {}) };
  const v = f as Variant & { filter?: Record<string, unknown> };
  const p = v.filter ?? {};
  /** A number parameter, plain or in units (pixels). */
  const n = (key: string) => {
    const value = p[key];
    return typeof value === "number" ? value : (value as { value: number }).value;
  };
  const s = (key: string) => p[key] as string;
  const make = (filter: Record<string, unknown>) => ({ ...filter, ...fade }) as Filter;
  switch (v.type) {
    case "gaussian blur":
      return make({ kind: "gaussian-blur", radius: n("radius") });
    case "box blur":
      return make({ kind: "box-blur", radius: n("radius") });
    case "motion blur":
      return make({ kind: "motion-blur", angle: n("angle"), distance: n("distance") });
    case "surface blur":
      return make({ kind: "surface-blur", radius: n("radius"), threshold: n("threshold") });
    case "median":
      return make({ kind: "median", radius: Math.max(1, Math.round(n("radius"))) });
    case "dust and scratches":
      return make({ kind: "dust-and-scratches", radius: n("radius"), threshold: n("threshold") });
    case "despeckle":
    case "average":
    case "blur":
    case "find edges":
    case "solarize":
      return make({ kind: v.type.replace(" ", "-") });
    case "blur more":
      return make({ kind: "blur-more" });
    case "sharpen more":
      return make({ kind: "sharpen-more" });
    case "sharpen edges":
      return make({ kind: "sharpen-edges" });
    case "unsharp mask":
      return make({ kind: "sharpen", amount: n("amount") / 100, radius: n("radius"), threshold: n("threshold") });
    case "high pass":
    case "maximum":
    case "minimum":
      return make({ kind: v.type === "high pass" ? "high-pass" : v.type, radius: n("radius") });
    case "emboss":
      return make({ kind: "emboss", angle: n("angle"), height: n("height"), amount: n("amount") });
    case "mosaic":
      return make({ kind: "pixelate", size: n("cellSize") });
    case "twirl":
      return make({ kind: "twirl", angle: n("angle") });
    case "pinch":
      return make({ kind: "pinch", amount: n("amount") });
    case "spherize":
      return make({ kind: "spherize", amount: n("amount"), mode: s("mode") === "horizontal only" ? "horizontal" : s("mode") === "vertical only" ? "vertical" : "normal" });
    case "polar coordinates":
      return make({ kind: "polar-coordinates", mode: s("conversion") === "rectangular to polar" ? "rect-to-polar" : "polar-to-rect" });
    case "offset": {
      const edges = (Object.entries(EDGES).find(([, ps]) => ps === s("undefinedAreas"))?.[0] ?? "wrap") as "wrap";
      return make({ kind: "offset", x: n("horizontal"), y: n("vertical"), edges });
    }
    default:
      return undefined;
  }
}
