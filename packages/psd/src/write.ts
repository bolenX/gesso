import { createHash } from "node:crypto";
import { adjustmentAssets, xmpPacket, type AdjustmentLayer, type Artboard, type BlendMode, paintColor, type Doc, type Effect, type Layer, type Paint, type Shape, type TextLayer } from "@gesso/core";
import { compose, defaultAssetLoader, renderArtboard, renderLayerParts, transformPoint, type Affine, type AssetLoader, type Box, type Backdrop, type LayerPart, type Rendered } from "@gesso/render";
import {
  writePsdUint8Array,
  type AdjustmentLayer as PsdAdjustment,
  type BezierKnot,
  type BlendMode as PsdBlendMode,
  type Layer as PsdLayer,
  type LayerEffectsInfo,
  type LinkedFile,
  type Filter as PsdFilter,
  type Psd,
  type VectorContent,
} from "ag-psd";
import sharp from "sharp";
import { toPsdFilter } from "./smartFilters.js";
import { toBezierMesh } from "./warp.js";

// PSD encoder. Writes both forms the spec asks for: parametric data (artboards,
// live text, adjustment layers, shape layers with vector masks) and Gesso's own
// rendered pixels, so the file looks right before Photoshop re-renders text.
// Smart layers become embedded smart objects: each symbol is written as its own
// PSD inside the file and placed with its corner pin, so double-clicking it in
// Photoshop opens the symbol with its live layers. Image layers whose filters all
// exist in Photoshop become smart objects with live smart filters; distorted (quad)
// layers become smart objects pinned by their corners, and warped layers smart
// objects with a custom warp, so text and shapes inside stay editable. Filters
// Photoshop has no match for are baked into the layer's pixels.
// Files carry an sRGB profile, the colour space Gesso renders in.

export type PsdOptions = {
  loader?: AssetLoader;
  /** Wrap each Gesso artboard in a PSD artboard (default). Off writes one plain canvas. */
  artboards?: boolean;
};
export type PsdResult = {
  bytes: Uint8Array;
  warnings: string[];
  /** Each artboard flattened, as rendered for the PSD's composite; reuse them instead of rendering again. */
  flats: Rendered[];
};

export async function writePsd(doc: Doc, options: PsdOptions = {}): Promise<PsdResult> {
  const bounds = unionBounds(doc.artboards);
  const width = Math.round(bounds.right - bounds.left);
  const height = Math.round(bounds.bottom - bounds.top);
  const composite = new Uint8Array(width * height * 4);
  const warnings: string[] = [];
  const children: PsdLayer[] = [];
  const asArtboards = options.artboards ?? true;
  if (!asArtboards && doc.artboards.length !== 1) throw new Error("A PSD without artboards holds exactly one artboard");

  const luts = new Map<string, Uint8Array>();
  for (const id of new Set(allLayers(doc).flatMap((l) => (l.type === "adjustment" ? adjustmentAssets(l.adjustment) : [])))) {
    const asset = doc.assets[id];
    if (asset) luts.set(id, await (options.loader ?? defaultAssetLoader())(asset));
  }

  // Each placed symbol is written once as an embedded PSD.
  const linkedFiles: LinkedFile[] = [];
  const symbolFiles = new Map<string, string>();
  for (const symbolId of placedSymbols(doc)) {
    const symbol = doc.symbols![symbolId]!;
    const inner: Doc = {
      id: symbol.id,
      revision: doc.revision,
      assets: doc.assets,
      ...(doc.symbols ? { symbols: doc.symbols } : {}),
      artboards: [
        {
          id: symbol.id,
          name: symbol.name,
          frame: { x: 0, y: 0, w: symbol.size[0], h: symbol.size[1] },
          ...(symbol.background ? { background: symbol.background } : {}),
          layers: symbol.layers,
        },
      ],
    };
    const result = await writePsd(inner, { ...options, artboards: false });
    warnings.push(...result.warnings.map((w) => `symbol "${symbol.id}": ${w}`));
    const id = guid(`symbol:${symbol.id}`);
    symbolFiles.set(symbol.id, id);
    linkedFiles.push({ id, name: `${symbol.name}.psd`, type: "8BPS", creator: "8BIM", data: result.bytes });
  }

  const flats: Rendered[] = [];
  for (const artboard of doc.artboards) {
    const ox = Math.round(artboard.frame.x - bounds.left);
    const oy = Math.round(artboard.frame.y - bounds.top);
    const rendered = await renderArtboard(doc, artboard.id, options.loader ? { loader: options.loader } : {});
    blit(composite, width, rendered.pixels, rendered.width, rendered.height, ox, oy);
    flats.push(rendered);

    const { parts, width: artboardWidth, warnings: w } = await renderLayerParts(doc, artboard.id, { ...(options.loader ? { loader: options.loader } : {}), ...(rendered.masks?.size ? { masks: rendered.masks } : {}) });
    warnings.push(...w.map((msg) => `${artboard.id}: ${msg}`));
    const embedded = await embedLayers(doc, artboard, parts, ox, oy, options, linkedFiles, warnings);
    const ctx: Ctx = { doc, parts, ox, oy, width: artboardWidth, warnings, symbolFiles, artboard: artboard.id, luts, embedded };

    const ctxBackdrops = rendered.backdrops ?? new Map();
    ctx.backdrops = ctxBackdrops;
    const layers = artboard.layers.flatMap((layer) => withBackdrop(layer, ctx));
    if (artboard.background) layers.unshift(backgroundLayer(artboard, ox, oy));
    if (!asArtboards) {
      children.push(...layers);
      continue;
    }
    children.push({
      name: artboard.name,
      opened: true,
      artboard: {
        rect: { top: oy, left: ox, bottom: oy + Math.round(artboard.frame.h), right: ox + Math.round(artboard.frame.w) },
        ...(artboard.preset ? { presetName: artboard.preset } : {}),
      },
      children: layers,
    });
  }

  const psd: Psd = {
    width,
    height,
    imageData: { width, height, data: composite },
    ...(asArtboards ? { artboards: { count: doc.artboards.length } } : {}),
    ...(linkedFiles.length ? { linkedFiles } : {}),
    imageResources: { xmpMetadata: xmpPacket(doc.id, doc.revision) },
    children,
  };
  if (doc.unknown?.length) warnings.push("opaque PSD blocks are not written yet; they were dropped");
  const bytes = withIccProfile(writePsdUint8Array(psd, { invalidateTextLayers: true, noBackground: true }), await srgbProfile());
  return { bytes, warnings, flats };
}

/** Per-artboard state. Part pixels are artboard-sized; ox/oy place them in the document. */
type Ctx = {
  doc: Doc;
  parts: Map<string, LayerPart>;
  ox: number;
  oy: number;
  width: number;
  warnings: string[];
  symbolFiles: Map<string, string>;
  artboard: string;
  /** Background blurs from the flattened render, baked into pixel layers. */
  backdrops?: Map<string, Backdrop>;
  /** .cube files for Color Lookup layers, by asset id; Photoshop keeps the LUT inside the layer. */
  luts: Map<string, Uint8Array>;
  /** Layers written as smart objects (live smart filters, or a corner pin), by layer id. */
  embedded: Map<string, Placed>;
};

type Placed = NonNullable<PsdLayer["placedLayer"]>;

/**
 * Finds the layers that become smart objects in this artboard and writes each one's content as an embedded PSD:
 * image layers whose filters all have Photoshop smart filters, and layers distorted with a quad. The content is the
 * layer undistorted and unfiltered at its own size; the outer layer keeps Gesso's pixels, opacity, blend, mask and effects.
 */
async function embedLayers(doc: Doc, artboard: Artboard, parts: Map<string, LayerPart>, ox: number, oy: number, options: PsdOptions, linkedFiles: LinkedFile[], warnings: string[]) {
  const out = new Map<string, Placed>();
  const visit = async (layers: Layer[]) => {
    for (const layer of layers) {
      if (layer.type === "group") {
        await visit(layer.children);
        continue;
      }
      const part = parts.get(layer.id);
      if (!part || layer.type === "smart" || layer.type === "adjustment") continue;
      const plain = !layer.quad && !layer.warp && !layer.rotation && !layer.flip && !layer.skew;
      const mapped = layer.type === "image" && plain && layer.filters?.length ? layer.filters.map((f) => toPsdFilter(f, psdBlend)) : undefined;
      const live = mapped?.every(Boolean) ? (mapped as PsdFilter[]) : undefined;
      if (mapped && !live) {
        const missing = layer.filters!.filter((_, i) => !mapped[i]).map((f) => f.kind);
        warnings.push(`${artboard.id}: image "${layer.id}" has filters Photoshop can't keep live (${[...new Set(missing)].join(", ")}), so its filters are baked into its pixels`);
      }
      const pinned = !!layer.quad && !layer.warp && part.quad?.length === 4;
      const warped = !!layer.warp && !layer.quad;
      if (layer.warp && layer.quad) warnings.push(`${artboard.id}: "${layer.id}" is both distorted and warped, so it's written as pixels`);
      if (!live && !pinned && !warped) continue;
      const box = part.frame ?? part.box;
      const [w, h] = [Math.max(1, Math.round(box.w)), Math.max(1, Math.round(box.h))];
      const inner: Record<string, unknown> = { ...layer, frame: { x: 0, y: 0, w, h } };
      for (const key of ["quad", "warp", "opacity", "blend", "mask", "clip", "blendIf", "effects", "fillOpacity", "visible", "rotation", "flip", "skew"]) delete inner[key];
      if (live) delete inner.filters;
      const content: Doc = {
        id: `${doc.id}-${layer.id}`,
        revision: doc.revision,
        assets: doc.assets,
        ...(doc.symbols ? { symbols: doc.symbols } : {}),
        artboards: [{ id: layer.id, name: layer.name, frame: { x: 0, y: 0, w, h }, layers: [inner as Layer] }],
      };
      const result = await writePsd(content, { ...options, artboards: false });
      warnings.push(...result.warnings.map((w) => `${artboard.id}: inside "${layer.id}": ${w}`));
      const id = guid(`embed:${doc.id}:${artboard.id}:${layer.id}`);
      linkedFiles.push({ id, name: `${layer.name}.psd`, type: "8BPS", creator: "8BIM", data: result.bytes });
      const corners = pinned ? part.quad! : [[box.x, box.y], [box.x + w, box.y], [box.x + w, box.y + h], [box.x, box.y + h]];
      const transform = corners.flatMap(([x, y]) => [x! + ox, y! + oy]);
      out.set(layer.id, {
        id,
        placed: guid(`placed:${artboard.id}:${layer.id}`),
        type: "raster",
        transform,
        nonAffineTransform: transform,
        width: w,
        height: h,
        ...(warped
          ? {
              warp: {
                style: "custom",
                value: 0,
                perspective: 0,
                perspectiveOther: 0,
                rotate: "horizontal",
                bounds: { top: { units: "Pixels", value: 0 }, left: { units: "Pixels", value: 0 }, bottom: { units: "Pixels", value: h }, right: { units: "Pixels", value: w } },
                uOrder: 4,
                vOrder: 4,
                customEnvelopeWarp: { meshPoints: toBezierMesh(layer.warp!, w, h) },
              },
            }
          : {}),
        ...(live ? { filter: { enabled: true, validAtPosition: true, maskEnabled: false, maskLinked: false, maskExtendWithWhite: true, list: live } } : {}),
      });
    }
  };
  await visit(artboard.layers);
  return out;
}

let srgb: Promise<Buffer> | undefined;

/** The sRGB ICC profile that ships with the image library, read once. */
function srgbProfile(): Promise<Buffer> {
  return (srgb ??= sharp({ create: { width: 1, height: 1, channels: 3, background: "#000000" } })
    .withIccProfile("srgb")
    .png()
    .toBuffer()
    .then(async (png) => (await sharp(png).metadata()).icc!));
}

/**
 * Adds an ICC profile (image resource 1039) to a PSD. The PSD layout is: a 26-byte header, the colour mode
 * section and the image resources section, each led by its length; the profile goes first among the resources.
 */
export function withIccProfile(psd: Uint8Array, icc: Uint8Array): Uint8Array {
  const view = new DataView(psd.buffer, psd.byteOffset, psd.byteLength);
  const resourcesAt = 26 + 4 + view.getUint32(26);
  const resourcesLength = view.getUint32(resourcesAt);
  const padded = icc.length + (icc.length % 2);
  const block = new Uint8Array(4 + 2 + 2 + 4 + padded);
  const b = new DataView(block.buffer);
  block.set([0x38, 0x42, 0x49, 0x4d], 0); // "8BIM"
  b.setUint16(4, 1039);
  // An empty Pascal name, padded to an even length: two zero bytes.
  b.setUint32(8, icc.length);
  block.set(icc, 12);
  const out = new Uint8Array(psd.length + block.length);
  out.set(psd.subarray(0, resourcesAt), 0);
  new DataView(out.buffer).setUint32(resourcesAt, resourcesLength + block.length);
  out.set(block, resourcesAt + 4);
  out.set(psd.subarray(resourcesAt + 4), resourcesAt + 4 + block.length);
  return out;
}

/**
 * The layer, preceded by its background blur baked as pixels: Photoshop has no live backdrop
 * blur, so the frosted part is a pixel layer and the glass shape above it stays live.
 */
function withBackdrop(layer: Layer, ctx: Ctx): PsdLayer[] {
  return [...backdropAndLayer(layer, ctx), ...patternOverlays(layer, ctx)];
}

/** Pattern overlays as pixel layers clipped to the layer: Photoshop files written here can't carry the patterns. */
function patternOverlays(layer: Layer, ctx: Ctx): PsdLayer[] {
  const overlays = ctx.parts.get(layer.id)?.overlays ?? [];
  if (!overlays.length) return [];
  if (!ctx.warnings.some((w) => w.startsWith("pattern overlay"))) ctx.warnings.push("pattern overlay is written as a pixel layer clipped above its layer");
  if (layer.clip) ctx.warnings.push(`layer "${layer.id}" is clipped, so its pattern overlay clips to the layer below it instead`);
  return overlays.map((o) => ({
    name: `${layer.name} · pattern overlay`,
    opacity: o.opacity,
    blendMode: psdBlend(o.blend),
    hidden: layer.visible === false,
    clipping: true,
    left: ctx.ox + o.box.x,
    top: ctx.oy + o.box.y,
    right: ctx.ox + o.box.x + o.box.w,
    bottom: ctx.oy + o.box.y + o.box.h,
    imageData: { width: o.box.w, height: o.box.h, data: o.pixels },
  }));
}

function backdropAndLayer(layer: Layer, ctx: Ctx): PsdLayer[] {
  const out = toPsdLayer(layer, ctx);
  const glass = ctx.backdrops?.get(layer.id);
  if (!glass) return [out];
  if (!ctx.warnings.some((w) => w.startsWith("background blur"))) {
    ctx.warnings.push("background blur has no live equivalent in Photoshop; each one is baked into a pixel layer just below its glass layer");
  }
  return [
    {
      name: `${layer.name} · background blur`,
      opacity: layer.opacity ?? 1,
      hidden: layer.visible === false,
      left: ctx.ox + glass.x,
      top: ctx.oy + glass.y,
      right: ctx.ox + glass.x + glass.w,
      bottom: ctx.oy + glass.y + glass.h,
      imageData: { width: glass.w, height: glass.h, data: glass.pixels },
    },
    out,
  ];
}

function toPsdLayer(layer: Layer, ctx: Ctx): PsdLayer {
  const part = ctx.parts.get(layer.id)!;
  const out: PsdLayer = {
    name: layer.name,
    opacity: layer.opacity ?? 1,
    blendMode: psdBlend(layer.blend),
    hidden: layer.visible === false,
    clipping: layer.clip === true,
    ...(layer.fillOpacity !== undefined ? { fillOpacity: layer.fillOpacity } : {}),
    ...(layer.blendIf ? { blendingRanges: blendingRanges(layer.blendIf) } : {}),
  };
  if (layer.meta?.locked) out.protected = { transparency: true, composite: true, position: true };
  if (part.mask) out.mask = maskData(part.mask, ctx);
  if (layer.effects?.length) out.effects = psdEffects(layer.effects);
  const placed = ctx.embedded.get(layer.id);
  if (placed) {
    Object.assign(out, pixelData(part, ctx));
    out.placedLayer = placed;
    return out;
  }

  switch (layer.type) {
    case "group":
      out.opened = true;
      if (layer.quad || layer.warp) ctx.warnings.push(`group "${layer.id}" is ${layer.warp ? "warped" : "distorted"}; Photoshop gets its layers undistorted`);
      if ((layer.isolation ?? "pass-through") === "pass-through" && (layer.blend ?? "normal") === "normal") {
        out.blendMode = "pass through";
      }
      out.children = layer.children.flatMap((child) => withBackdrop(child, ctx));
      return out;
    case "adjustment":
      out.adjustment = psdAdjustment(layer.adjustment, ctx);
      return out;
    case "text":
      Object.assign(out, pixelData(part, ctx));
      if (distorted(layer, ctx)) return out;
      if (layer.path) {
        ctx.warnings.push(`text "${layer.id}" follows a path, which is written as pixels; Photoshop type on a path isn't supported yet`);
        return out;
      }
      out.text = psdText(layer, part, ctx);
      return out;
    case "shape": {
      Object.assign(out, pixelData(part, ctx));
      if (distorted(layer, ctx)) return out;
      Object.assign(out, vectorShape(layer, part, ctx));
      return out;
    }
    case "image":
      Object.assign(out, pixelData(part, ctx));
      return out;
    case "smart": {
      Object.assign(out, pixelData(part, ctx));
      const [w, h] = ctx.doc.symbols![layer.symbol]!.size;
      const transform = part.quad!.flatMap(([x, y]) => [x + ctx.ox, y + ctx.oy]);
      out.placedLayer = {
        id: ctx.symbolFiles.get(layer.symbol)!,
        placed: guid(`placed:${ctx.artboard}:${layer.id}`),
        type: "raster",
        transform,
        nonAffineTransform: transform,
        width: w,
        height: h,
      };
      return out;
    }
  }
}

/** Symbols placed anywhere in the document, including inside other symbols. */
/** Every layer in the document's artboards and symbols, groups included. */
function allLayers(doc: Doc): Layer[] {
  const out: Layer[] = [];
  const visit = (layers: Layer[]) => layers.forEach((l) => (out.push(l), l.type === "group" && visit(l.children)));
  doc.artboards.forEach((a) => visit(a.layers));
  Object.values(doc.symbols ?? {}).forEach((s) => visit(s.layers));
  return out;
}

function placedSymbols(doc: Doc): string[] {
  const found = new Set<string>();
  const visit = (layers: Layer[]) => {
    for (const layer of layers) {
      if (layer.type === "group") visit(layer.children);
      if (layer.type === "smart" && !found.has(layer.symbol) && doc.symbols?.[layer.symbol]) {
        found.add(layer.symbol);
        visit(doc.symbols[layer.symbol]!.layers);
      }
    }
  };
  for (const artboard of doc.artboards) visit(artboard.layers);
  return [...found];
}

/** Deterministic GUIDs, so the same document always writes the same file. */
function guid(seed: string): string {
  const h = createHash("md5").update(seed).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function backgroundLayer(artboard: Artboard, ox: number, oy: number): PsdLayer {
  const w = Math.round(artboard.frame.w);
  const h = Math.round(artboard.frame.h);
  const bg = artboard.background!;
  if (typeof bg === "string") {
    // A fill layer: vectorFill without a vector mask covers the whole artboard.
    const [r, g, b] = hex(bg);
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) data.set([r, g, b, 255], i);
    return { name: "Background", top: oy, left: ox, bottom: oy + h, right: ox + w, imageData: { width: w, height: h, data }, vectorFill: { type: "color", color: rgb(bg) } };
  }
  return { name: "Background", top: oy, left: ox, bottom: oy + h, right: ox + w };
}

/** Crops a part's pixels to their non-transparent bounds, placed in document coordinates. */
/** A part's pixels, already cropped to their content, placed in document coordinates. */
function pixelData(part: LayerPart, ctx: Ctx): Partial<PsdLayer> {
  if (!part.pixels || !part.pixelBox) return {};
  const { x, y, w, h } = part.pixelBox;
  return { left: ctx.ox + x, top: ctx.oy + y, right: ctx.ox + x + w, bottom: ctx.oy + y + h, imageData: { width: w, height: h, data: part.pixels } };
}

function maskData(mask: Uint8Array, ctx: Ctx): PsdLayer["mask"] {
  const width = ctx.width;
  const height = mask.length / width;
  const data = new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) data.set([mask[i]!, mask[i]!, mask[i]!, 255], i * 4);
  return { left: ctx.ox, top: ctx.oy, right: ctx.ox + width, bottom: ctx.oy + height, defaultColor: 0, imageData: { width, height, data } };
}

function psdText(layer: TextLayer, part: LayerPart, ctx: Ctx): NonNullable<PsdLayer["text"]> {
  const { style } = layer;
  const box = offset(part.box, ctx);
  const size = part.fontSize ?? style.size;
  const font = Object.values(ctx.doc.assets).find((a) => a.kind === "font" && a.family === style.font);
  const fill = style.fill === undefined ? "#000000" : paintColor(style.fill);
  const justification = { start: "left", center: "center", end: "right", justify: "justify-left" } as const;
  const area = layer.box?.kind !== "point";
  if (layer.direction === "rtl") ctx.warnings.push(`text "${layer.id}": RTL paragraph direction is not written to PSD yet`);
  return {
    text: layer.content.replace(/\n/g, "\r"),
    transform: textTransform(part, area ? 0 : size * 0.8, ctx),
    shapeType: area ? "box" : "point",
    ...(area ? { boxBounds: [0, 0, box.w, box.h] } : {}),
    style: {
      font: { name: font?.postscriptName ?? style.font.replace(/\s+/g, "") },
      fontSize: size,
      fillColor: rgb(fill),
      tracking: style.tracking ?? 0,
      ...(style.leading ? { leading: style.leading, autoLeading: false } : { autoLeading: true }),
      ...((style.weight ?? 400) >= 600 && !font?.postscriptName ? { fauxBold: true } : {}),
    },
    paragraphStyle: { justification: justification[style.align ?? "start"] },
    ...(layer.runs ? { styleRuns: textRuns(layer, size, ctx) } : {}),
  };
}

function psdAdjustment(adjustment: AdjustmentLayer["adjustment"], ctx: Ctx): PsdAdjustment {
  const cmyk = (v?: readonly number[]) => (v ? { c: v[0]!, m: v[1]!, y: v[2]!, k: v[3]! } : { c: 0, m: 0, y: 0, k: 0 });
  const balance = (v?: readonly number[]) => ({ cyanRed: v?.[0] ?? 0, magentaGreen: v?.[1] ?? 0, yellowBlue: v?.[2] ?? 0 });
  const mix = (v: readonly number[] | undefined, fallback: [number, number, number, number]) => {
    const [red, green, blue, constant] = v ?? fallback;
    return { red: red!, green: green!, blue: blue!, constant: constant! };
  };
  switch (adjustment.kind) {
    case "brightness-contrast":
      return { type: "brightness/contrast", brightness: adjustment.brightness, contrast: adjustment.contrast, useLegacy: false };
    case "levels":
      return {
        type: "levels",
        // ag-psd writes its "blue" channel where Photoshop reads green and vice versa; swap them so Photoshop gets the right one.
        [{ rgb: "rgb", red: "red", green: "blue", blue: "green" }[adjustment.channel ?? "rgb"]]: {
          shadowInput: adjustment.inputBlack,
          highlightInput: adjustment.inputWhite,
          midtoneInput: adjustment.gamma,
          shadowOutput: adjustment.outputBlack ?? 0,
          highlightOutput: adjustment.outputWhite ?? 255,
        },
      };
    case "curves": {
      const curve = (points: Array<[number, number]>) => points.map(([input, output]) => ({ input, output }));
      const out: PsdAdjustment & { type: "curves" } = { type: "curves", [adjustment.channel ?? "rgb"]: curve(adjustment.points) };
      for (const channel of ["red", "green", "blue"] as const) if (adjustment[channel]) out[channel] = curve(adjustment[channel]);
      return out;
    }
    case "hue-saturation": {
      // Photoshop's range bounds (a–d, degrees) for each colour, and the shifts within them.
      const bounds = { reds: [315, 345, 15, 45], yellows: [15, 45, 75, 105], greens: [75, 105, 135, 165], cyans: [135, 165, 195, 225], blues: [195, 225, 255, 285], magentas: [255, 285, 315, 345] } as const;
      const out: PsdAdjustment & { type: "hue/saturation" } = {
        type: "hue/saturation",
        master: { a: 0, b: 0, c: 0, d: 0, hue: adjustment.hue, saturation: adjustment.saturation, lightness: adjustment.lightness },
      };
      for (const [name, [a, b, c, d]] of Object.entries(bounds) as Array<[keyof typeof bounds, readonly number[]]>) {
        const shift = adjustment.ranges?.[name];
        out[name] = { a: a!, b: b!, c: c!, d: d!, hue: shift?.hue ?? 0, saturation: shift?.saturation ?? 0, lightness: shift?.lightness ?? 0 };
      }
      return out;
    }
    case "gradient-map":
      return {
        type: "gradient map",
        name: "Gesso gradient",
        gradientType: "solid",
        smoothness: 1,
        reverse: adjustment.reverse ?? false,
        colorStops: adjustment.stops.map((s) => ({ color: rgb(s.color), location: s.offset, midpoint: 0.5 })),
        opacityStops: [
          { opacity: 1, location: 0, midpoint: 0.5 },
          { opacity: 1, location: 1, midpoint: 0.5 },
        ],
      };
    case "exposure":
      return { type: "exposure", exposure: adjustment.exposure, offset: adjustment.offset ?? 0, gamma: adjustment.gamma ?? 1 };
    case "vibrance":
      return { type: "vibrance", vibrance: adjustment.vibrance, saturation: adjustment.saturation ?? 0 };
    case "color-balance":
      return {
        type: "color balance",
        shadows: balance(adjustment.shadows),
        midtones: balance(adjustment.midtones),
        highlights: balance(adjustment.highlights),
        preserveLuminosity: adjustment.preserveLuminosity ?? true,
      };
    case "black-white":
      return {
        type: "black & white",
        reds: adjustment.reds ?? 40,
        yellows: adjustment.yellows ?? 60,
        greens: adjustment.greens ?? 40,
        cyans: adjustment.cyans ?? 60,
        blues: adjustment.blues ?? 20,
        magentas: adjustment.magentas ?? 80,
        useTint: !!adjustment.tint,
        tintColor: rgb(adjustment.tint ?? "#E1D3B3"),
      };
    case "photo-filter":
      return { type: "photo filter", color: rgb(adjustment.color), density: adjustment.density, preserveLuminosity: adjustment.preserveLuminosity ?? true };
    case "channel-mixer":
      return {
        type: "channel mixer",
        monochrome: !!adjustment.monochrome,
        red: mix(adjustment.red, [100, 0, 0, 0]),
        green: mix(adjustment.green, [0, 100, 0, 0]),
        blue: mix(adjustment.blue, [0, 0, 100, 0]),
        gray: mix(adjustment.monochrome, [40, 40, 20, 0]),
      };
    case "color-lookup": {
      const data = ctx.luts.get(adjustment.lut);
      const name = ctx.doc.assets[adjustment.lut]?.uri.split("/").pop() ?? `${adjustment.lut}.cube`;
      return { type: "color lookup", lookupType: "3dlut", name, lutFormat: "cube", dataOrder: "rgb", tableOrder: "bgr", lut3DFileName: name, ...(data ? { lut3DFileData: data } : {}) };
    }
    case "invert":
      return { type: "invert" };
    case "posterize":
      return { type: "posterize", levels: adjustment.levels };
    case "threshold":
      return { type: "threshold", level: adjustment.level };
    case "selective-color":
      return {
        type: "selective color",
        mode: adjustment.mode ?? "relative",
        reds: cmyk(adjustment.reds),
        yellows: cmyk(adjustment.yellows),
        greens: cmyk(adjustment.greens),
        cyans: cmyk(adjustment.cyans),
        blues: cmyk(adjustment.blues),
        magentas: cmyk(adjustment.magentas),
        whites: cmyk(adjustment.whites),
        neutrals: cmyk(adjustment.neutrals),
        blacks: cmyk(adjustment.blacks),
      };
  }
}

const KAPPA = 0.5522847498;

/** Bezier knots for live shape layers: [in-handle, anchor, out-handle], clockwise. */
export function shapeKnots(shape: Shape, b: Box): BezierKnot[] | undefined {
  const knot = (ix: number, iy: number, x: number, y: number, ox: number, oy: number): BezierKnot => ({
    linked: true,
    points: [ix, iy, x, y, ox, oy],
  });
  const { x, y, w, h } = b;
  if (shape.kind === "ellipse") {
    const [cx, cy, kx, ky] = [x + w / 2, y + h / 2, (w / 2) * KAPPA, (h / 2) * KAPPA];
    return [
      knot(cx - kx, y, cx, y, cx + kx, y),
      knot(x + w, cy - ky, x + w, cy, x + w, cy + ky),
      knot(cx + kx, y + h, cx, y + h, cx - kx, y + h),
      knot(x, cy + ky, x, cy, x, cy - ky),
    ];
  }
  if (shape.kind === "rect") {
    const r = Math.min(shape.radius ?? 0, w / 2, h / 2);
    if (r === 0) return [knot(x, y, x, y, x, y), knot(x + w, y, x + w, y, x + w, y), knot(x + w, y + h, x + w, y + h, x + w, y + h), knot(x, y + h, x, y + h, x, y + h)];
    const k = r * KAPPA;
    return [
      knot(x + r - k, y, x + r, y, x + r, y),
      knot(x + w - r, y, x + w - r, y, x + w - r + k, y),
      knot(x + w, y + r - k, x + w, y + r, x + w, y + r),
      knot(x + w, y + h - r, x + w, y + h - r, x + w, y + h - r + k),
      knot(x + w - r + k, y + h, x + w - r, y + h, x + w - r, y + h),
      knot(x + r, y + h, x + r, y + h, x + r - k, y + h),
      knot(x, y + h - r + k, x, y + h - r, x, y + h - r),
      knot(x, y + r, x, y + r, x, y + r - k),
    ];
  }
  return undefined; // SVG paths are written as pixels for now
}

/**
 * A live shape layer: the outline as a vector mask, with fill and stroke as editable content.
 * Shapes Photoshop can't hold as one (semi-transparent colours, neither fill nor stroke) stay pixels.
 */
function vectorShape(layer: Extract<Layer, { type: "shape" }>, part: LayerPart, ctx: Ctx): Partial<PsdLayer> {
  const turn = part.matrix ? (Math.atan2(part.matrix[1], part.matrix[0]) * 180) / Math.PI : 0;
  const fill = layer.fill === undefined ? undefined : vectorContent(layer.fill, turn);
  const stroke = layer.stroke ? vectorContent(layer.stroke.paint, turn) : undefined;
  if (fill === null || stroke === null || (!fill && !stroke)) return {};
  const outlines = part.paths
    ? part.paths.map((p) => ({ open: !p.closed, knots: pathKnots(p.points, p.closed) }))
    : [{ open: false, knots: shapeKnots(layer.shape, part.box) ?? [] }];
  const paths = outlines
    .filter((p) => p.knots.length > 1)
    .map((p) => ({ open: p.open, fillRule: "non-zero" as const, knots: p.knots.map((k) => ({ ...k, points: placePoints(k.points, part.matrix, ctx) })) }));
  if (!paths.length) return {};
  return {
    vectorFill: fill ?? stroke!,
    vectorMask: { paths },
    ...(layer.stroke
      ? {
          vectorStroke: {
            strokeEnabled: true,
            fillEnabled: fill !== undefined,
            lineWidth: { units: "Pixels" as const, value: layer.stroke.width },
            lineAlignment: "center" as const,
            ...(layer.stroke.cap ? { lineCapType: layer.stroke.cap } : {}),
            ...(layer.stroke.join ? { lineJoinType: layer.stroke.join } : {}),
            content: stroke!,
          },
        }
      : {}),
  };
}

/** Mixed styling as Photoshop style runs, sized like the rendered text. */
function textRuns(layer: TextLayer, size: number, ctx: Ctx): NonNullable<NonNullable<PsdLayer["text"]>["styleRuns"]> {
  const k = size / layer.style.size;
  const fontFor = (family: string) => Object.values(ctx.doc.assets).find((a) => a.kind === "font" && a.family === family);
  return layer.runs!.map((run) => {
    const family = run.font ?? layer.style.font;
    const font = fontFor(family);
    const weight = run.weight ?? layer.style.weight ?? 400;
    return {
      length: run.text.length,
      style: {
        font: { name: font?.postscriptName ?? family.replace(/\s+/g, "") },
        fontSize: (run.size ?? layer.style.size) * k,
        ...(run.fill ? { fillColor: rgb(run.fill) } : {}),
        ...(run.tracking !== undefined ? { tracking: run.tracking } : {}),
        ...(weight >= 600 && !font?.postscriptName ? { fauxBold: true } : {}),
      },
    };
  });
}

/** Gesso effects as Photoshop layer styles, with the same defaults the renderer uses. Spread (choke) is a percentage Photoshop stores as a plain number. */
function psdEffects(effects: Effect[]): LayerEffectsInfo {
  const px = (value: number) => ({ units: "Pixels" as const, value });
  const on = { present: true, showInDialog: true, enabled: true };
  const info: LayerEffectsInfo = {};
  for (const e of effects) {
    if (e.kind === "drop-shadow") {
      (info.dropShadow ??= []).push({
        ...on,
        color: rgb(e.color ?? "#000000"),
        opacity: e.opacity ?? 0.35,
        angle: e.angle ?? 120,
        useGlobalLight: false,
        distance: px(e.distance ?? 10),
        size: px(e.size ?? 10),
        choke: px(Math.round((e.spread ?? 0) * 100)),
        blendMode: "multiply",
      });
    } else if (e.kind === "outer-glow") {
      info.outerGlow = { ...on, color: rgb(e.color ?? "#FFFFFF"), opacity: e.opacity ?? 0.75, size: px(e.size ?? 20), choke: px(Math.round((e.spread ?? 0) * 100)), blendMode: "screen" };
    } else if (e.kind === "stroke") {
      (info.stroke ??= []).push({ ...on, size: px(e.width), position: e.position ?? "outside", fillType: "color", color: rgb(e.color), opacity: e.opacity ?? 1, blendMode: "normal" });
    } else if (e.kind === "color-overlay") {
      (info.solidFill ??= []).push({ ...on, color: rgb(e.color), opacity: e.opacity ?? 1, blendMode: psdBlend(e.blend) });
    } else if (e.kind === "inner-shadow") {
      (info.innerShadow ??= []).push({
        ...on,
        color: rgb(e.color ?? "#000000"),
        opacity: e.opacity ?? 0.75,
        angle: e.angle ?? 120,
        useGlobalLight: false,
        distance: px(e.distance ?? 5),
        size: px(e.size ?? 5),
        choke: px(Math.round((e.choke ?? 0) * 100)),
        blendMode: psdBlend(e.blend ?? "multiply"),
      });
    } else if (e.kind === "inner-glow") {
      info.innerGlow = {
        ...on,
        color: rgb(e.color ?? "#FFFFBE"),
        opacity: e.opacity ?? 0.75,
        size: px(e.size ?? 5),
        choke: px(Math.round((e.choke ?? 0) * 100)),
        source: e.source ?? "edge",
        blendMode: psdBlend(e.blend ?? "screen"),
      };
    } else if (e.kind === "bevel") {
      info.bevel = {
        ...on,
        style: ({ "inner-bevel": "inner bevel", "outer-bevel": "outer bevel", emboss: "emboss", "pillow-emboss": "pillow emboss" } as const)[e.style ?? "inner-bevel"],
        technique: "smooth",
        strength: e.depth ?? 100,
        direction: e.direction ?? "up",
        size: px(e.size ?? 5),
        soften: px(e.soften ?? 0),
        angle: e.angle ?? 120,
        altitude: e.altitude ?? 30,
        useGlobalLight: false,
        highlightColor: rgb(e.highlight ?? "#FFFFFF"),
        highlightOpacity: e.highlightOpacity ?? 0.75,
        highlightBlendMode: "screen",
        shadowColor: rgb(e.shadow ?? "#000000"),
        shadowOpacity: e.shadowOpacity ?? 0.75,
        shadowBlendMode: "multiply",
      };
    } else if (e.kind === "satin") {
      info.satin = {
        ...on,
        color: rgb(e.color ?? "#000000"),
        opacity: e.opacity ?? 0.5,
        angle: e.angle ?? 19,
        distance: px(e.distance ?? 11),
        size: px(e.size ?? 14),
        invert: e.invert ?? false,
        blendMode: psdBlend(e.blend ?? "multiply"),
      };
    } else if (e.kind === "gradient-overlay") {
      (info.gradientOverlay ??= []).push({
        ...on,
        opacity: e.opacity ?? 1,
        blendMode: psdBlend(e.blend),
        angle: e.angle ?? 90,
        type: e.style ?? "linear",
        scale: e.scale ?? 100,
        reverse: e.reverse ?? false,
        align: true,
        gradient: {
          name: "Gesso gradient",
          type: "solid",
          smoothness: 1,
          colorStops: e.stops.map((st) => ({ color: rgb(st.color), location: st.offset, midpoint: 0.5 })),
          opacityStops: [
            { opacity: 1, location: 0, midpoint: 0.5 },
            { opacity: 1, location: 1, midpoint: 0.5 },
          ],
        },
      });
    }
  }
  return info;
}

/** Photoshop fill content for a paint, or null when it can't be expressed (a translucent flat colour). */
function vectorContent(paint: Paint, turn: number): VectorContent | null {
  if (typeof paint === "string") return alpha(paint) < 1 ? null : { type: "color", color: rgb(paint) };
  // Photoshop has no mesh gradients: those shapes stay pixels.
  if (paint.kind === "mesh-gradient") return null;
  return {
    type: "solid",
    name: "Gesso gradient",
    style: paint.kind === "linear-gradient" ? "linear" : "radial",
    ...(paint.kind === "linear-gradient" ? { angle: paint.angle - turn } : {}),
    scale: 100,
    colorStops: paint.stops.map((s) => ({ color: rgb(s.color), location: s.offset, midpoint: 0.5 })),
    opacityStops: paint.stops.map((s) => ({ opacity: alpha(s.color), location: s.offset, midpoint: 0.5 })),
  };
}

/** Cubic subpath points [x0, y0, c1, c2, end, …] as Photoshop knots: [in-handle, anchor, out-handle]. */
export function pathKnots(points: number[], closed: boolean): BezierKnot[] {
  const anchors = [{ x: points[0]!, y: points[1]!, in: [points[0]!, points[1]!], out: [points[0]!, points[1]!] }];
  for (let i = 2; i + 5 < points.length; i += 6) {
    anchors[anchors.length - 1]!.out = [points[i]!, points[i + 1]!];
    anchors.push({ x: points[i + 4]!, y: points[i + 5]!, in: [points[i + 2]!, points[i + 3]!], out: [points[i + 4]!, points[i + 5]!] });
  }
  const first = anchors[0]!;
  const last = anchors[anchors.length - 1]!;
  if (closed && anchors.length > 1 && Math.hypot(last.x - first.x, last.y - first.y) < 0.01) {
    first.in = last.in;
    anchors.pop();
  }
  return anchors.map((a) => ({ linked: false, points: [a.in[0]!, a.in[1]!, a.x, a.y, a.out[0]!, a.out[1]!] }));
}

/** Artboard points, rotated with the layer and placed in document coordinates. */
function placePoints(points: number[], matrix: Affine | undefined, ctx: Ctx): number[] {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 2) {
    const [x, y] = transformPoint(matrix, points[i]!, points[i + 1]!);
    out.push(x + ctx.ox, y + ctx.oy);
  }
  return out;
}

/** Photoshop's text matrix: the layer's rotation, then the text origin (baseline for point text). */
function textTransform(part: LayerPart, baseline: number, ctx: Ctx): number[] {
  const [a, b, c, d, e, f] = compose(part.matrix, [1, 0, 0, 1, part.box.x, part.box.y + baseline])!;
  return [a, b, c, d, e + ctx.ox, f + ctx.oy];
}

/** Distorted and warped text and shapes are written as pixels: Photoshop's warp data can't be written here. */
function distorted(layer: Layer, ctx: Ctx): boolean {
  if (!layer.warp && !layer.quad) return false;
  ctx.warnings.push(`${layer.type} "${layer.id}" is ${layer.warp ? "warped" : "distorted"}, so it's written as pixels`);
  return true;
}

/** Blend If as Photoshop's blending ranges: grey in the composite pair, colours per channel. */
function blendingRanges(blendIf: NonNullable<Layer["blendIf"]>): NonNullable<PsdLayer["blendingRanges"]> {
  const all = [0, 0, 255, 255];
  const channel = blendIf.channel ?? "gray";
  const pick = (c: string) => (channel === c ? { sourceRange: [...(blendIf.this ?? all)], destRange: [...(blendIf.underlying ?? all)] } : { sourceRange: all, destRange: all });
  return {
    compositeGrayBlendSource: channel === "gray" ? [...(blendIf.this ?? all)] : all,
    compositeGraphBlendDestinationRange: channel === "gray" ? [...(blendIf.underlying ?? all)] : all,
    ranges: ["red", "green", "blue"].map(pick),
  };
}

function psdBlend(blend: BlendMode | undefined): PsdBlendMode {
  return (blend ?? "normal").replace("-", " ") as PsdBlendMode;
}

function offset(box: Box, ctx: Ctx): Box {
  return { x: box.x + ctx.ox, y: box.y + ctx.oy, w: box.w, h: box.h };
}

function hex(color: string): [number, number, number] {
  const n = color.slice(1);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16)];
}

function alpha(color: string): number {
  return color.length === 9 ? parseInt(color.slice(7, 9), 16) / 255 : 1;
}

function rgb(color: string) {
  const [r, g, b] = hex(color);
  return { r, g, b };
}

function unionBounds(artboards: Artboard[]) {
  if (artboards.length === 0) throw new Error("Document has no artboards");
  return artboards.reduce(
    (acc, a) => ({
      left: Math.min(acc.left, a.frame.x),
      top: Math.min(acc.top, a.frame.y),
      right: Math.max(acc.right, a.frame.x + a.frame.w),
      bottom: Math.max(acc.bottom, a.frame.y + a.frame.h),
    }),
    { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
  );
}

function blit(dst: Uint8Array, dstW: number, src: Uint8Array, w: number, h: number, ox: number, oy: number): void {
  for (let y = 0; y < h; y++) dst.set(src.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * dstW + ox) * 4);
}
