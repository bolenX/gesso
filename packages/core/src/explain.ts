import type { z } from "zod";
import { AdjustmentLayer, Artboard, Doc, GroupLayer, ImageLayer, ShapeLayer, SmartLayer, SmartObject, TextLayer } from "./schema.js";

// Agents write documents by hand, so input gets two kinds of help: forgiving
// defaults for fields that have an obvious value, and errors that name the
// layer and the fix instead of dumping every branch of the layer union.

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

const LAYER_SCHEMAS: Record<string, z.ZodTypeAny> = {
  image: ImageLayer,
  shape: ShapeLayer,
  text: TextLayer,
  adjustment: AdjustmentLayer,
  group: GroupLayer,
  smart: SmartLayer,
};
export const LAYER_TYPES = Object.keys(LAYER_SCHEMAS);

/** Fills in fields with an obvious default. Returns a new value; the input is untouched. */
export function normalizeDoc(input: unknown): unknown {
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return input;
    }
  }
  if (!isObject(input)) return input;
  const doc: Json = { revision: 0, assets: {}, ...input };
  if (Array.isArray(doc.artboards)) doc.artboards = doc.artboards.map(normalizeArtboard);
  if (isObject(doc.symbols)) {
    doc.symbols = Object.fromEntries(Object.entries(doc.symbols).map(([key, symbol]) => [key, normalizeSymbol(symbol, key)]));
  }
  return doc;
}

function normalizeArtboard(input: unknown): unknown {
  if (!isObject(input)) return input;
  const board: Json = { ...input };
  // "width"/"height" at the top of an artboard mean its frame.
  if (!board.frame && typeof board.width === "number" && typeof board.height === "number") {
    board.frame = { x: 0, y: 0, w: board.width, h: board.height };
    delete board.width;
    delete board.height;
  }
  board.name ??= board.id;
  if (Array.isArray(board.layers)) board.layers = board.layers.map(normalizeLayer);
  return board;
}

/** A symbol's size as [w, h], from whichever spelling the agent used. */
function normalizeSymbol(input: unknown, key: string): unknown {
  if (!isObject(input)) return input;
  const symbol: Json = { id: key, ...input };
  symbol.name ??= symbol.id;
  const pair = (w: unknown, h: unknown) => (typeof w === "number" && typeof h === "number" ? [w, h] : undefined);
  if (!Array.isArray(symbol.size)) {
    const size = isObject(symbol.size) ? symbol.size : undefined;
    const frame = isObject(symbol.frame) ? symbol.frame : undefined;
    const found =
      pair(size?.w, size?.h) ?? pair(size?.width, size?.height) ?? pair(symbol.w, symbol.h) ?? pair(symbol.width, symbol.height) ?? pair(frame?.w, frame?.h);
    if (found) symbol.size = found;
  }
  for (const k of ["w", "h", "width", "height", "frame"]) delete symbol[k];
  if (Array.isArray(symbol.layers)) symbol.layers = symbol.layers.map(normalizeLayer);
  return symbol;
}

export function normalizeLayer(input: unknown): unknown {
  if (!isObject(input)) return input;
  const layer: Json = { ...input };
  layer.name ??= layer.id;
  // Text given only as runs gets its content from them.
  if (layer.type === "text" && layer.content === undefined && Array.isArray(layer.runs)) {
    layer.content = layer.runs.map((r) => (isObject(r) && typeof r.text === "string" ? r.text : "")).join("");
  }
  if (Array.isArray(layer.children)) layer.children = layer.children.map(normalizeLayer);
  return layer;
}

/** Plain-language problems with a document, one per line, each naming where and what to fix. */
export function docIssues(input: unknown): string[] {
  if (!isObject(input)) return ["doc must be a JSON object: { id, artboards: [...] }"];
  const issues = describe(Doc.omit({ artboards: true, symbols: true }).safeParse(input), "doc");
  if (!Array.isArray(input.artboards)) issues.push("doc.artboards: required, a list of artboards");
  else {
    input.artboards.forEach((board, i) => {
      const where = `artboards[${i}]${isObject(board) && typeof board.id === "string" ? ` "${board.id}"` : ""}`;
      if (!isObject(board)) return issues.push(`${where}: must be an object`);
      issues.push(...describe(Artboard.omit({ layers: true }).safeParse(board), where));
      if (!Array.isArray(board.layers)) issues.push(`${where}.layers: required, a list of layers (bottom to top)`);
      else board.layers.forEach((layer, j) => issues.push(...layerIssues(layer, `${where}.layers[${j}]`)));
    });
  }
  if (input.symbols !== undefined) {
    if (!isObject(input.symbols)) issues.push('doc.symbols: must be an object of symbols by ID, e.g. { "word": { "size": [200, 50], "layers": [...] } }');
    else
      for (const [key, symbol] of Object.entries(input.symbols)) {
        const where = `symbols["${key}"]`;
        if (!isObject(symbol)) {
          issues.push(`${where}: must be an object`);
          continue;
        }
        issues.push(...describe(SmartObject.omit({ layers: true }).safeParse(symbol), where));
        if (!Array.isArray(symbol.layers)) issues.push(`${where}.layers: required, a list of layers (bottom to top)`);
        else symbol.layers.forEach((layer, j) => issues.push(...layerIssues(layer, `${where}.layers[${j}]`)));
      }
  }
  return issues;
}

/** Problems with one layer, checked against the schema for its own type only. */
export function layerIssues(layer: unknown, where = "layer"): string[] {
  if (!isObject(layer)) return [`${where}: must be an object`];
  const label = `${where}${typeof layer.id === "string" ? ` "${layer.id}"` : ""}`;
  const schema = typeof layer.type === "string" ? LAYER_SCHEMAS[layer.type] : undefined;
  if (!schema) return [`${label}: type ${JSON.stringify(layer.type)} is not a layer type; use one of ${LAYER_TYPES.join(", ")}`];
  if (layer.type !== "group") return describe(schema.safeParse(layer), `${label} (${layer.type})`);
  // Check a group's own fields, then each child against its own type.
  const own = describe(schema.safeParse({ ...layer, children: [] }), `${label} (group)`);
  const children = Array.isArray(layer.children)
    ? layer.children.flatMap((child, k) => layerIssues(child, `${label}.children[${k}]`))
    : [];
  return [...own, ...children];
}

/** What a field should look like, for the fields agents most often get wrong. */
const HINTS: Record<string, string> = {
  frame: 'needs { "x", "y", "w", "h" } in pixels, or { "anchor": "top-left" | "center" | …, "margin"?, "w"?, "h"? }',
  fill: 'needs a colour like "#FF4F1A", { "kind": "linear-gradient", "angle", "stops": [{ "offset", "color" }] }, { "kind": "radial-gradient", "stops" } or { "kind": "mesh-gradient", "colors": [[row of colours], …], "points"? }',
  background: 'needs a colour like "#FFFFFF", or a gradient',
  shape: 'needs { "kind": "rect", "radius"? }, { "kind": "ellipse" } or { "kind": "path", "d": "<svg path>" }',
  style: 'needs { "font": "<family of a font asset>", "size", "weight"?, "fill"?, "align"? }',
  size: "needs [width, height] in pixels, e.g. [200, 50]",
  quad: "needs four [x, y] corners: top-left, top-right, bottom-right, bottom-left",
};

function describe(result: z.SafeParseReturnType<unknown, unknown>, where: string): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.length ? `.${issue.path.join(".")}` : "";
    const key = issue.path[issue.path.length - 1];
    const hint = typeof key === "string" ? HINTS[key] : undefined;
    const message = hint && (issue.code === "invalid_union" || issue.code === "invalid_type")
      ? hint
      : issue.code === "invalid_type" && issue.received === "undefined"
        ? `required (${issue.expected})`
        : issue.code === "invalid_union"
          ? "doesn't match any allowed form"
          : issue.code === "unrecognized_keys"
            ? `unknown field(s) ${issue.keys.join(", ")}`
            : issue.message;
    return `${where}${path}: ${message}`;
  });
}
