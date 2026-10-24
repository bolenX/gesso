import { createHash } from "node:crypto";
import { xmpPacket, type AdjustmentLayer, type Artboard, type BlendMode, type Doc, type Effect, type Layer, type Paint, type Shape, type TextLayer } from "@gesso/core";
import { compose, renderArtboard, renderLayerParts, transformPoint, type Affine, type AssetLoader, type Box, type LayerPart } from "@gesso/render";
import {
  writePsdUint8Array,
  type AdjustmentLayer as PsdAdjustment,
  type BezierKnot,
  type BlendMode as PsdBlendMode,
  type Layer as PsdLayer,
  type LayerEffectsInfo,
  type LinkedFile,
  type Psd,
  type VectorContent,
} from "ag-psd";

// PSD encoder. Writes both forms the spec asks for: parametric data (artboards,
// live text, adjustment layers, shape layers with vector masks) and Gesso's own
// rendered pixels, so the file looks right before Photoshop re-renders text.
// Smart layers become embedded smart objects: each symbol is written as its own
// PSD inside the file and placed with its corner pin, so double-clicking it in
// Photoshop opens the symbol with its live layers. Smart filters are baked into
// layer pixels for now.

export type PsdOptions = {
  loader?: AssetLoader;
  /** Wrap each Gesso artboard in a PSD artboard (default). Off writes one plain canvas. */
  artboards?: boolean;
};
export type PsdResult = { bytes: Uint8Array; warnings: string[] };

export async function writePsd(doc: Doc, options: PsdOptions = {}): Promise<PsdResult> {
  const bounds = unionBounds(doc.artboards);
  const width = Math.round(bounds.right - bounds.left);
  const height = Math.round(bounds.bottom - bounds.top);
  const composite = new Uint8Array(width * height * 4);
  const warnings: string[] = [];
  const children: PsdLayer[] = [];
  const asArtboards = options.artboards ?? true;
  if (!asArtboards && doc.artboards.length !== 1) throw new Error("A PSD without artboards holds exactly one artboard");

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

  for (const artboard of doc.artboards) {
    const ox = Math.round(artboard.frame.x - bounds.left);
    const oy = Math.round(artboard.frame.y - bounds.top);
    const rendered = await renderArtboard(doc, artboard.id, options.loader ? { loader: options.loader } : {});
    blit(composite, width, rendered.pixels, rendered.width, rendered.height, ox, oy);

    const { parts, width: artboardWidth, warnings: w } = await renderLayerParts(doc, artboard.id, options.loader ? { loader: options.loader } : {});
    warnings.push(...w.map((msg) => `${artboard.id}: ${msg}`));
    const ctx: Ctx = { doc, parts, ox, oy, width: artboardWidth, warnings, symbolFiles, artboard: artboard.id };
    const layers = artboard.layers.map((layer) => toPsdLayer(layer, ctx));
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
  const bytes = writePsdUint8Array(psd, { invalidateTextLayers: true, noBackground: true });
  return { bytes, warnings };
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
};

function toPsdLayer(layer: Layer, ctx: Ctx): PsdLayer {
  const part = ctx.parts.get(layer.id)!;
  const out: PsdLayer = {
    name: layer.name,
    opacity: layer.opacity ?? 1,
    blendMode: psdBlend(layer.blend),
    hidden: layer.visible === false,
    clipping: layer.clip === true,
  };
  if (layer.meta?.locked) out.protected = { transparency: true, composite: true, position: true };
  if (part.mask) out.mask = maskData(part.mask, ctx);
  if (layer.effects?.length) out.effects = psdEffects(layer.effects);

  switch (layer.type) {
    case "group":
      out.opened = true;
      if ((layer.isolation ?? "pass-through") === "pass-through" && (layer.blend ?? "normal") === "normal") {
        out.blendMode = "pass through";
      }
      out.children = layer.children.map((child) => toPsdLayer(child, ctx));
      return out;
    case "adjustment":
      out.adjustment = psdAdjustment(layer.adjustment);
      return out;
    case "text":
      Object.assign(out, pixelData(part, ctx));
      out.text = psdText(layer, part, ctx);
      return out;
    case "shape": {
      Object.assign(out, pixelData(part, ctx));
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
  const fill = typeof style.fill === "string" ? style.fill : (style.fill?.stops[0]?.color ?? "#000000");
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

function psdAdjustment(adjustment: AdjustmentLayer["adjustment"]): PsdAdjustment {
  switch (adjustment.kind) {
    case "brightness-contrast":
      return { type: "brightness/contrast", brightness: adjustment.brightness, contrast: adjustment.contrast, useLegacy: false };
    case "levels":
      return {
        type: "levels",
        rgb: {
          shadowInput: adjustment.inputBlack,
          highlightInput: adjustment.inputWhite,
          midtoneInput: adjustment.gamma,
          shadowOutput: adjustment.outputBlack ?? 0,
          highlightOutput: adjustment.outputWhite ?? 255,
        },
      };
    case "curves":
      return { type: "curves", [adjustment.channel ?? "rgb"]: adjustment.points.map(([input, output]) => ({ input, output })) };
    case "hue-saturation":
      return {
        type: "hue/saturation",
        master: { a: 0, b: 0, c: 0, d: 0, hue: adjustment.hue, saturation: adjustment.saturation, lightness: adjustment.lightness },
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
    } else {
      (info.solidFill ??= []).push({ ...on, color: rgb(e.color), opacity: e.opacity ?? 1, blendMode: "normal" });
    }
  }
  return info;
}

/** Photoshop fill content for a paint, or null when it can't be expressed (a translucent flat colour). */
function vectorContent(paint: Paint, turn: number): VectorContent | null {
  if (typeof paint === "string") return alpha(paint) < 1 ? null : { type: "color", color: rgb(paint) };
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
