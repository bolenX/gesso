import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Doc, Layer, Op } from "@gesso/core";
import { alignTo, blendWeights, renderArtboard, renderLayerParts, stackMasks, type AssetLoader, type Rgba } from "@gesso/render";
import sharp from "sharp";
import { only } from "./production.js";

// Edit › Auto-Align Layers and Auto-Blend Layers, for exposures shot from (nearly) the same place:
// focus stacks, exposure brackets and burst frames.

/** Each layer rendered alone on a transparent artboard, at full size. */
async function alone(doc: Doc, artboard: string, ids: string[], loader: AssetLoader): Promise<Rgba[]> {
  return Promise.all(ids.map(async (id) => renderArtboard(only(doc, artboard, new Set([id])), artboard, { loader }).then((r) => ({ width: r.width, height: r.height, pixels: r.pixels }))));
}

function findLayer(doc: Doc, artboard: string, id: string): Layer {
  const walk = (layers: Layer[]): Layer | undefined => {
    for (const l of layers) {
      if (l.id === id) return l;
      if (l.type === "group") {
        const found = walk(l.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  const board = doc.artboards.find((a) => a.id === artboard);
  if (!board) throw new Error(`No artboard "${artboard}"`);
  const layer = walk(board.layers);
  if (!layer) throw new Error(`No layer "${id}" in "${artboard}"`);
  return layer;
}

export type AlignRequest = { artboard: string; reference: string; layers: string[]; scale?: boolean; rotation?: boolean };

/** The ops that move each layer onto the reference, and what was found for each. */
export async function alignLayers(doc: Doc, request: AlignRequest, loader: AssetLoader) {
  const [ref, ...moving] = await alone(doc, request.artboard, [request.reference, ...request.layers], loader);
  const ops: Op[] = [];
  const results = [];
  for (const [k, id] of request.layers.entries()) {
    const layer = findLayer(doc, request.artboard, id);
    if ("anchor" in layer.frame) throw new Error(`Layer "${id}" is placed by anchor; give it an absolute frame (x, y, w, h) before aligning`);
    const a = alignTo(ref!, moving[k]!, { ...(request.scale ? { scale: true } : {}), ...(request.rotation ? { rotation: true } : {}) });
    const { x, y, w, h } = layer.frame;
    const round = (v: number) => Math.round(v * 100) / 100;
    // Scale about the frame's centre, then shift.
    const frame = { x: round(x + w / 2 - (w * a.scale) / 2 + a.dx), y: round(y + h / 2 - (h * a.scale) / 2 + a.dy), w: round(w * a.scale), h: round(h * a.scale) };
    ops.push({ op: "set", target: `${request.artboard} #${id}`, path: "frame", value: frame });
    if (a.rotation) ops.push({ op: "set", target: `${request.artboard} #${id}`, path: "rotation", value: round((layer.rotation ?? 0) + a.rotation) });
    results.push({ layer: id, shift: [round(a.dx), round(a.dy)], scale: round(a.scale * 1000) / 1000, rotation: a.rotation, confidence: a.confidence });
  }
  return { ops, results };
}

export type StackRequest = { artboard: string; layers: string[]; mode: "focus" | "exposure"; smoothness?: number };

/**
 * Masks that merge the layers into one image: for a focus stack, each pixel from the sharpest frame; for an
 * exposure bracket, each from the best-exposed frames (exposure fusion). Writes the masks as images under
 * assets/ and returns the ops that attach them as raster masks, the layers kept in their order.
 */
export async function stackLayers(doc: Doc, request: StackRequest, baseDir: string, loader: AssetLoader) {
  if (request.layers.length < 2) throw new Error("Give at least two layers to blend");
  const board = doc.artboards.find((a) => a.id === request.artboard);
  if (!board) throw new Error(`No artboard "${request.artboard}"`);
  // Bottom to top, as they're stacked.
  const order: string[] = [];
  const walk = (layers: Layer[]) => layers.forEach((l) => (order.push(l.id), l.type === "group" && walk(l.children)));
  walk(board.layers);
  for (const id of request.layers) if (!order.includes(id)) throw new Error(`No layer "${id}" in "${request.artboard}"`);
  const ids = [...request.layers].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const images = await alone(doc, request.artboard, ids, loader);
  const { width: w, height: h } = images[0]!;
  const smoothness = request.smoothness ?? Math.max(4, Math.round(Math.min(w, h) / 100));
  const masks = stackMasks(blendWeights(images, request.mode, smoothness));
  const { parts } = await renderLayerParts(doc, request.artboard, { loader });
  const dir = join(baseDir, "assets");
  await mkdir(dir, { recursive: true });
  const ops: Op[] = [];
  for (const [k, id] of ids.entries()) {
    if (k === 0) {
      ops.push({ op: "set", target: `${request.artboard} #${id}`, path: "mask", value: null });
      continue;
    }
    // Raster masks stretch over the layer's box: crop the artboard-sized mask to it.
    const box = parts.get(id)!.box;
    const [x0, y0] = [Math.max(0, Math.round(box.x)), Math.max(0, Math.round(box.y))];
    const [bw, bh] = [Math.max(1, Math.min(w - x0, Math.round(box.w))), Math.max(1, Math.min(h - y0, Math.round(box.h)))];
    const crop = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) crop.set(masks[k]!.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + bw), y * bw);
    const file = `${doc.id}-${id}-${request.mode}-stack.png`;
    await writeFile(join(dir, file), await sharp(Buffer.from(crop), { raw: { width: bw, height: bh, channels: 1 } }).png().toBuffer());
    const asset = `${id}-${request.mode}-mask`;
    ops.push({ op: "asset", id: asset, asset: { uri: `assets/${file}`, kind: "mask", width: bw, height: bh, description: `Auto-Blend (${request.mode}) mask for ${id}` } });
    ops.push({ op: "set", target: `${request.artboard} #${id}`, path: "mask", value: { kind: "raster", asset } });
  }
  return { ops, layers: ids };
}
