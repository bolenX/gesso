import type { Doc, Layer } from "@gesso/core";
import { encode, renderArtboard, type AssetLoader, type ColorOptions, type EncodeFormat, type Rendered } from "@gesso/render";

// Slices, the way Photoshop's Generate › Image Assets reads layer names: a layer or group named
// like a file ("logo.png", "200% hero.jpg", "hero.jpg80", "512x512 icon.png", several separated
// by commas) is exported on its own, cropped to its pixels.

export type Slice = { layer: string; artboard: string; file: string; format: EncodeFormat; scale: number; quality: number; size?: [number, number] };

const SPEC = /^\s*(?:(\d+(?:\.\d+)?)%\s+|(\d+)x(\d+)\s+)?([^,]+?)\.(png|jpe?g|webp|tiff?)(\d{1,3})?\s*$/i;

/** The file specs in a layer name, or none when it isn't named like a file. */
export function parseSlices(name: string): Array<Omit<Slice, "layer" | "artboard">> {
  return name.split(",").flatMap((part) => {
    const m = SPEC.exec(part);
    if (!m) return [];
    const ext = m[5]!.toLowerCase();
    const format: EncodeFormat = ext.startsWith("jp") ? "jpeg" : ext.startsWith("tif") ? "tiff" : (ext as EncodeFormat);
    return [
      {
        file: `${m[4]!.trim()}.${ext === "jpeg" ? "jpg" : ext === "tiff" ? "tif" : ext}`,
        format,
        scale: m[1] ? Number(m[1]) / 100 : 1,
        quality: m[6] ? Math.min(100, Number(m[6])) : 90,
        ...(m[2] ? { size: [Number(m[2]), Number(m[3])] as [number, number] } : {}),
      },
    ];
  });
}

/** Every slice in the document, by artboard. */
export function findSlices(doc: Doc): Slice[] {
  const out: Slice[] = [];
  const visit = (layers: Layer[], artboard: string) => {
    for (const layer of layers) {
      for (const spec of parseSlices(layer.name)) out.push({ ...spec, layer: layer.id, artboard });
      if (layer.type === "group") visit(layer.children, artboard);
    }
  };
  for (const artboard of doc.artboards) visit(artboard.layers, artboard.id);
  return out;
}

/** The document with only one layer showing (and the groups it sits in), on a transparent artboard. */
function isolate(doc: Doc, artboardId: string, layerId: string): Doc {
  const keep = (layers: Layer[]): [Layer[], boolean] => {
    let found = false;
    const next = layers.map((layer) => {
      if (layer.id === layerId) {
        found = true;
        return layer;
      }
      if (layer.type === "group") {
        const [children, inside] = keep(layer.children);
        if (inside) {
          found = true;
          return { ...layer, children };
        }
      }
      // Adjustments below the layer still recolour it, as in Photoshop's asset export.
      return layer.type === "adjustment" ? layer : ({ ...layer, visible: false } as Layer);
    });
    return [next, found];
  };
  return {
    ...doc,
    artboards: doc.artboards
      .filter((a) => a.id === artboardId)
      .map((a) => {
        const rest = { ...a };
        delete rest.background;
        return { ...rest, layers: keep(a.layers)[0] };
      }),
  };
}

/** Crops a render to its pixels that aren't transparent. */
function trim(r: Rendered): Rendered {
  const { width: w, height: h, pixels } = r;
  let [x0, y0, x1, y1] = [w, h, -1, -1];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (pixels[(y * w + x) * 4 + 3]! > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { ...r, width: 1, height: 1, pixels: new Uint8Array(4) };
  const [cw, ch] = [x1 - x0 + 1, y1 - y0 + 1];
  const out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(pixels.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
  return { ...r, width: cw, height: ch, pixels: out };
}

/** Renders one slice: the layer alone, cropped, at its scale or size. */
export async function renderSlice(doc: Doc, slice: Slice, loader: AssetLoader, color: ColorOptions = {}): Promise<{ bytes: Buffer; width: number; height: number; warnings: string[] }> {
  const rendered = trim(await renderArtboard(isolate(doc, slice.artboard, slice.layer), slice.artboard, { scale: slice.scale, loader }));
  let bytes = await encode(rendered, slice.format, slice.quality, undefined, color);
  let [width, height] = [rendered.width, rendered.height];
  if (slice.size) {
    // A fixed size fits the slice inside it, centred, keeping its proportions.
    const sharp = (await import("sharp")).default;
    bytes = await sharp(bytes).resize(slice.size[0], slice.size[1], { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).toFormat(slice.format === "jpeg" ? "jpeg" : slice.format).toBuffer();
    [width, height] = slice.size;
  }
  return { bytes, width, height, warnings: rendered.warnings };
}
