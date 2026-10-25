import { mkdir, readdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Asset, Doc, Layer, Op } from "@gesso/core";
import { encode, renderArtboard, type AssetLoader, type ColorOptions, type EncodeFormat, type Rendered } from "@gesso/render";
import { writePsd } from "@gesso/psd";
import { importAsset } from "./import.js";
import { resolvePath } from "./paths.js";

// Production tools: Stamp Visible / Merge Layers (merged pixels as a new layer) and Batch /
// data-driven graphics (a template run over many images or rows of data).

const walk = (layers: Layer[], visit: (layer: Layer, parents: Layer[]) => void, parents: Layer[] = []) => {
  for (const layer of layers) {
    visit(layer, parents);
    if (layer.type === "group") walk(layer.children, visit, [...parents, layer]);
  }
};

/** The artboard with only the given layers showing (and the groups around them). */
function only(doc: Doc, artboardId: string, ids: Set<string>): Doc {
  const keep = (layers: Layer[]): Layer[] =>
    layers.map((layer) => {
      if (ids.has(layer.id)) return layer;
      if (layer.type === "group") {
        let inside = false;
        walk(layer.children, (l) => (inside ||= ids.has(l.id)));
        if (inside) return { ...layer, children: keep(layer.children) };
      }
      return { ...layer, visible: false } as Layer;
    });
  return {
    ...doc,
    artboards: doc.artboards
      .filter((a) => a.id === artboardId)
      .map((a) => {
        const rest = { ...a };
        delete rest.background;
        return { ...rest, layers: keep(a.layers) };
      }),
  };
}

export type StampRequest = {
  artboard: string;
  id: string;
  /** Layers to merge; every visible layer (and the background) when left out. */
  layers?: string[];
  region?: { x: number; y: number; w: number; h: number };
  /** Remove the merged layers (Merge Layers) instead of keeping them under the stamp. */
  merge?: boolean;
};

/** Renders the stamp, saves it under assets/, and returns the ops that add it as an image layer. */
export async function stamp(doc: Doc, request: StampRequest, baseDir: string, loader: AssetLoader): Promise<{ ops: Op[]; warnings: string[] }> {
  const artboard = doc.artboards.find((a) => a.id === request.artboard);
  if (!artboard) throw new Error(`No artboard "${request.artboard}"`);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(request.id)) throw new Error(`Layer id "${request.id}" should be short letters, digits, - or _`);
  const ids = request.layers ? new Set(request.layers) : undefined;
  const order: string[] = [];
  walk(artboard.layers, (l) => order.push(l.id));
  for (const id of ids ?? []) if (!order.includes(id)) throw new Error(`No layer "${id}" in artboard "${artboard.id}"`);
  const rendered = await renderArtboard(ids ? only(doc, artboard.id, ids) : doc, artboard.id, { loader });
  const region = request.region ?? { x: 0, y: 0, w: artboard.frame.w, h: artboard.frame.h };
  const cropped = crop(rendered, region);
  const dir = join(baseDir, "assets");
  await mkdir(dir, { recursive: true });
  const file = `${doc.id}-${request.id}.png`;
  await writeFile(join(dir, file), await encode(cropped, "png"));
  const asset: Asset = { uri: `assets/${file}`, kind: "image", width: cropped.width, height: cropped.height, description: ids ? `Merged: ${[...ids].join(", ")}` : "Stamp of the visible layers" };
  const layer = { id: request.id, name: ids ? "Merged" : "Stamp", type: "image", asset: request.id, fit: "fill", frame: region };
  // On top of the artboard, or just above the topmost merged layer.
  const top = ids ? order.filter((id) => ids.has(id)).pop()! : undefined;
  const ops: Op[] = [{ op: "asset", id: request.id, asset }, top ? { op: "insert", after: `#${top}`, layer } : { op: "insert", into: `#${artboard.id}`, layer }];
  if (ids && request.merge) for (const id of ids) ops.push({ op: "remove", target: `#${id}` });
  return { ops, warnings: rendered.warnings };
}

function crop(r: Rendered, region: { x: number; y: number; w: number; h: number }): Rendered {
  const [x0, y0] = [Math.max(0, Math.round(region.x)), Math.max(0, Math.round(region.y))];
  const [w, h] = [Math.max(1, Math.min(r.width - x0, Math.round(region.w))), Math.max(1, Math.min(r.height - y0, Math.round(region.h)))];
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(r.pixels.subarray(((y0 + y) * r.width + x0) * 4, ((y0 + y) * r.width + x0 + w) * 4), y * w * 4);
  return { ...r, width: w, height: h, pixels: out };
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".avif", ".gif"]);

export type BatchRequest = {
  /** Image layer ids that each source image replaces. */
  layer?: string;
  /** A folder of images, or a list of image paths (relative to the Gesso folder). */
  sources?: string | string[];
  /** Data-driven graphics: one output per row; keys are layer ids (text layers take the text, image layers a path), plus an optional "name". */
  rows?: Array<Record<string, string>>;
  outDir: string;
  format: EncodeFormat | "psd";
  scale: number;
  color?: ColorOptions;
};

/** Runs the template once per source image or data row and writes every artboard of each. */
export async function batch(doc: Doc, request: BatchRequest, baseDir: string, loader: AssetLoader, confined = false) {
  let rows: Array<Record<string, string>> = request.rows ?? [];
  if (request.sources !== undefined) {
    if (!request.layer) throw new Error("With sources, name the image layer they replace in \"layer\"");
    let paths = Array.isArray(request.sources) ? request.sources : [];
    if (typeof request.sources === "string") {
      const dir = resolvePath(baseDir, request.sources, confined);
      paths = (await readdir(dir)).filter((f) => IMAGE_EXT.has(extname(f).toLowerCase())).sort().map((f) => join(dir, f));
      if (!paths.length) throw new Error(`No images in ${dir}`);
    }
    rows = paths.map((p) => ({ name: basename(p, extname(p)), [request.layer!]: p }));
  }
  if (!rows.length) throw new Error("Give sources (images) or rows (data) to run the template over");
  const layers = new Map<string, Layer>();
  for (const artboard of doc.artboards) walk(artboard.layers, (l) => layers.set(l.id, l));
  const dir = resolvePath(baseDir, request.outDir, confined);
  await mkdir(dir, { recursive: true });
  const files: Array<{ row: string; artboard?: string; path: string; warnings: string[] }> = [];
  for (const [index, row] of rows.entries()) {
    const name = (row.name ?? `${index + 1}`).replace(/[^\w.-]+/g, "-");
    const variant: Doc = structuredClone(doc);
    const byId = new Map<string, Layer>();
    for (const artboard of variant.artboards) walk(artboard.layers, (l) => byId.set(l.id, l));
    for (const [key, value] of Object.entries(row)) {
      if (key === "name") continue;
      const layer = byId.get(key);
      if (!layer || !layers.has(key)) throw new Error(`Row ${index + 1}: no layer "${key}" in the template`);
      if (layer.type === "text") {
        layer.content = value;
        delete layer.runs;
      } else if (layer.type === "image") {
        const id = `batch-${key}-${index + 1}`;
        variant.assets[id] = await importAsset({ id, source: value }, baseDir, confined);
        layer.asset = id;
      } else throw new Error(`Row ${index + 1}: layer "${key}" is a ${layer.type}; rows fill text and image layers`);
    }
    if (request.format === "psd") {
      const { bytes, warnings } = await writePsd(variant, { loader });
      const path = join(dir, `${name}.psd`);
      await writeFile(path, bytes);
      files.push({ row: name, path, warnings });
      continue;
    }
    const ext = request.format === "jpeg" ? "jpg" : request.format === "tiff" ? "tif" : request.format;
    for (const artboard of variant.artboards) {
      const rendered = await renderArtboard(variant, artboard.id, { scale: request.scale, loader });
      const path = join(dir, variant.artboards.length > 1 ? `${name}-${artboard.id}.${ext}` : `${name}.${ext}`);
      await writeFile(path, await encode(rendered, request.format, 90, undefined, request.color ?? {}));
      files.push({ row: name, artboard: artboard.id, path, warnings: rendered.warnings });
    }
  }
  return { files };
}
