import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artboard, Asset, BlendMode, Doc, Effect, Layer, Paint, SmartObject } from "@gesso/core";
import { readPsd, type BezierPath, type Color as PsdColor, type Layer as PsdLayer, type LinkedFile, type VectorContent } from "ag-psd";
import sharp from "sharp";

// Opens a PSD as a Gesso document. Layers keep their structure and stay editable where
// Gesso has an equivalent: text, shapes, smart objects, adjustments, masks, effects.
// Pixel layers become image assets written next to the document.

export type ImportOptions = {
  /** Document id; defaults to the file name. */
  id: string;
  /** Folder the extracted images go in; asset uris are written relative to `uriBase`. */
  assetDir: string;
  /** Prefix for asset uris, e.g. "imported/poster". */
  uriBase: string;
  /** Prefix for asset and symbol ids, so nested smart objects don't clash with their parent. */
  idPrefix?: string;
  /** Finds an installed font by PostScript name. Text whose font isn't found still imports, with a warning. */
  findFont?: (postscriptName: string) => Promise<{ uri: string; family: string; face?: number } | undefined>;
};

export type ImportResult = { doc: Doc; warnings: string[] };

type Box = { x: number; y: number; w: number; h: number };
type Adjustment = Extract<Layer, { type: "adjustment" }>["adjustment"];

type Ctx = {
  options: ImportOptions;
  assets: Record<string, Asset>;
  symbols: Record<string, SmartObject>;
  linked: Map<string, LinkedFile>;
  warnings: string[];
  ids: Set<string>;
  boardIds: Set<string>;
  fonts: Map<string, string>;
  /** Images to write once the document is assembled: [asset id, png bytes]. */
  pending: Array<Promise<void>>;
};

const BLEND: Record<string, BlendMode> = {
  normal: "normal",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  "color dodge": "color-dodge",
  "color burn": "color-burn",
  "hard light": "hard-light",
  "soft light": "soft-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

export async function importPsd(bytes: Uint8Array, options: ImportOptions): Promise<ImportResult> {
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true, skipCompositeImageData: true });
  await mkdir(options.assetDir, { recursive: true });
  const ctx: Ctx = {
    options,
    assets: {},
    symbols: {},
    linked: new Map((psd.linkedFiles ?? []).map((f) => [f.id, f])),
    warnings: [],
    ids: new Set(),
    boardIds: new Set(),
    fonts: new Map(),
    pending: [],
  };
  const top = psd.children ?? [];
  const boards = top.filter((l) => l.artboard);
  const artboards: Artboard[] = [];
  if (boards.length) {
    for (const board of boards) {
      const r = board.artboard!.rect;
      const frame = { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
      artboards.push(await convertBoard(board.name ?? "Artboard", board.children ?? [], frame, ctx));
    }
    const loose = top.filter((l) => !l.artboard);
    if (loose.length) ctx.warnings.push(`${loose.length} layer(s) outside artboards were left out`);
  } else {
    artboards.push(await convertBoard("Canvas", top, { x: 0, y: 0, w: psd.width, h: psd.height }, ctx));
  }
  await Promise.all(ctx.pending);
  const doc: Doc = { id: options.id, revision: 0, assets: ctx.assets, artboards, ...(Object.keys(ctx.symbols).length ? { symbols: ctx.symbols } : {}) };
  return { doc, warnings: ctx.warnings };
}

async function convertBoard(name: string, children: PsdLayer[], frame: Box, ctx: Ctx): Promise<Artboard> {
  const id = uniqueId(name, ctx, "artboard", ctx.boardIds);
  ctx.ids.clear(); // layer ids are unique per artboard
  const origin = { x: frame.x, y: frame.y, w: frame.w, h: frame.h };
  let background: Paint | undefined;
  let rest = children;
  // Gesso writes a solid Background fill layer for artboard backgrounds; turn it back into one.
  const first = children[0];
  if (first && first.name === "Background" && first.vectorFill?.type === "color" && !first.vectorMask) {
    background = hex(first.vectorFill.color);
    rest = children.slice(1);
  }
  const layers = await convertLayers(rest, origin, ctx);
  return { id, name, frame, ...(background ? { background } : {}), layers };
}

async function convertLayers(layers: PsdLayer[], origin: Box, ctx: Ctx): Promise<Layer[]> {
  const out: Layer[] = [];
  for (const layer of layers) {
    try {
      const converted = await convertLayer(layer, origin, ctx);
      if (converted) out.push(converted);
    } catch (err) {
      ctx.warnings.push(`layer "${layer.name}": ${(err as Error).message}; left out`);
    }
  }
  return out;
}

async function convertLayer(layer: PsdLayer, origin: Box, ctx: Ctx): Promise<Layer | undefined> {
  const name = layer.name ?? "Layer";
  const id = uniqueId(name, ctx, "layer");
  const bounds = { x: (layer.left ?? 0) - origin.x, y: (layer.top ?? 0) - origin.y, w: (layer.right ?? 0) - (layer.left ?? 0), h: (layer.bottom ?? 0) - (layer.top ?? 0) };
  const base: Record<string, unknown> = { id, name };
  if (layer.hidden) base.visible = false;
  if (layer.opacity !== undefined && layer.opacity < 1) base.opacity = round(layer.opacity, 3);
  if (layer.clipping) base.clip = true;
  if (layer.blendMode && layer.blendMode !== "normal" && layer.blendMode !== "pass through") {
    const blend = BLEND[layer.blendMode];
    if (blend) base.blend = blend;
    else ctx.warnings.push(`layer "${name}": blend mode "${layer.blendMode}" isn't supported yet; using normal`);
  }
  if (layer.protected?.position || layer.protected?.composite) base.meta = { locked: true };
  const effects = layer.effects ? convertEffects(layer, ctx) : [];
  if (effects.length) base.effects = effects;

  if (layer.children) {
    const isolation = layer.blendMode === "pass through" ? {} : { isolation: "isolate" };
    const children = await convertLayers(layer.children, origin, ctx);
    return { ...base, type: "group", ...isolation, frame: { x: 0, y: 0, w: origin.w, h: origin.h }, children } as Layer;
  }

  if (layer.adjustment) {
    const adjustment = convertAdjustment(layer.adjustment);
    if (!adjustment) {
      ctx.warnings.push(`layer "${name}": ${layer.adjustment.type} adjustments aren't supported yet; left out`);
      return undefined;
    }
    return { ...base, type: "adjustment", adjustment, frame: { x: 0, y: 0, w: origin.w, h: origin.h } } as Layer;
  }

  const mask = layer.mask?.imageData ? await convertMask(layer, id, bounds, origin, ctx) : undefined;
  if (mask) base.mask = mask;

  if (layer.text) return convertText(layer, base, origin, ctx);

  if (layer.placedLayer) {
    const smart = await convertSmart(layer, base, origin, ctx);
    if (smart) return smart;
  }

  if (layer.vectorFill || layer.vectorStroke) {
    const shape = convertShape(layer, base, origin, ctx);
    if (shape) return shape;
  }

  if (!layer.imageData || bounds.w <= 0 || bounds.h <= 0) {
    if (!layer.imageData) ctx.warnings.push(`layer "${name}" has no pixels; left out`);
    return undefined;
  }
  const asset = await saveImage(id, layer.imageData, ctx);
  return { ...base, type: "image", asset, fit: "fill", frame: bounds } as Layer;
}

async function convertText(layer: PsdLayer, base: Record<string, unknown>, origin: Box, ctx: Ctx): Promise<Layer> {
  const text = layer.text!;
  const style = text.style ?? {};
  const [a = 1, b = 0, c = 0, d = 1, tx = 0, ty = 0] = text.transform ?? [];
  const scale = Math.hypot(a, b) || 1;
  const rotation = (Math.atan2(b, a) * 180) / Math.PI;
  const size = round((style.fontSize ?? 24) * scale, 2);
  const family = await fontFamily(style.font?.name, ctx);
  const align = { left: "start", center: "center", right: "end", "justify-left": "justify", "justify-center": "justify", "justify-right": "justify", "justify-all": "justify" } as const;
  const content = text.text.replace(/\r/g, "\n").replace(/\n$/, "");
  const textStyle: Record<string, unknown> = { font: family, size };
  if (style.fillColor) textStyle.fill = hex(style.fillColor);
  if (style.tracking) textStyle.tracking = style.tracking;
  if (style.leading && !style.autoLeading) textStyle.leading = round(style.leading * scale, 2);
  if (style.fauxBold) textStyle.weight = 700;
  const justification = text.paragraphStyle?.justification;
  if (justification && justification !== "left") textStyle.align = align[justification];

  let frame: Box;
  let box: Record<string, unknown>;
  if (text.shapeType === "box" && text.boxBounds) {
    const [l = 0, t = 0, r = 0, btm = 0] = text.boxBounds;
    const [w, h] = [(r - l) * scale, (btm - t) * scale];
    // Gesso rotates around the box centre: find where Photoshop's matrix puts it.
    const [cx, cy] = [a * ((l + r) / 2) + c * ((t + btm) / 2) + tx, b * ((l + r) / 2) + d * ((t + btm) / 2) + ty];
    frame = { x: cx - w / 2 - origin.x, y: cy - h / 2 - origin.y, w, h };
    box = { kind: "area" };
  } else {
    // Point text sits on its baseline; Gesso places the top of the line.
    const w = Math.max(1, (layer.right ?? 0) - (layer.left ?? 0));
    const h = Math.max(1, (layer.bottom ?? 0) - (layer.top ?? 0));
    frame = { x: tx - origin.x, y: ty - size * 0.8 - origin.y, w, h };
    box = { kind: "point" };
  }
  const out: Record<string, unknown> = { ...base, type: "text", content, style: textStyle, box, frame: rounded(frame) };
  if (Math.abs(rotation) > 0.01) out.rotation = round(rotation, 2);
  if (text.styleRuns && text.styleRuns.length > 1) {
    let at = 0;
    const runs = [];
    for (const run of text.styleRuns) {
      const piece = text.text.slice(at, at + run.length).replace(/\r/g, "\n");
      at += run.length;
      const r: Record<string, unknown> = { text: piece };
      if (run.style.font?.name && run.style.font.name !== style.font?.name) r.font = await fontFamily(run.style.font.name, ctx);
      if (run.style.fontSize && run.style.fontSize !== style.fontSize) r.size = round(run.style.fontSize * scale, 2);
      if (run.style.fillColor) r.fill = hex(run.style.fillColor);
      if (run.style.tracking !== undefined && run.style.tracking !== style.tracking) r.tracking = run.style.tracking;
      if (run.style.fauxBold) r.weight = 700;
      runs.push(r);
    }
    // Photoshop ends text with a paragraph mark Gesso doesn't keep.
    const last = runs[runs.length - 1]!;
    last.text = (last.text as string).replace(/\n$/, "");
    if (runs.map((r) => r.text).join("") === content) out.runs = runs.filter((r) => r.text !== "");
  }
  return out as Layer;
}

/** The family a font asset registers for this PostScript name, adding the asset when the font is installed. */
async function fontFamily(postscriptName: string | undefined, ctx: Ctx): Promise<string> {
  const name = postscriptName ?? "ArialMT";
  const known = ctx.fonts.get(name);
  if (known) return known;
  const found = await ctx.options.findFont?.(name);
  const family = found?.family ?? name;
  ctx.fonts.set(name, family);
  if (found) {
    ctx.assets[`font-${slug(name)}`] = { uri: found.uri, kind: "font", family, postscriptName: name, ...(found.face ? { face: found.face } : {}) };
  } else {
    ctx.warnings.push(`font "${name}" isn't installed; text using it keeps its settings but renders in a fallback font until you add it (font_list, asset_import)`);
  }
  return family;
}

function convertShape(layer: PsdLayer, base: Record<string, unknown>, origin: Box, ctx: Ctx): Layer | undefined {
  const fill = layer.vectorStroke?.fillEnabled === false ? undefined : layer.vectorFill ? paint(layer.vectorFill) : undefined;
  const strokeContent = layer.vectorStroke?.strokeEnabled && layer.vectorStroke.content ? paint(layer.vectorStroke.content) : undefined;
  const stroke = strokeContent ? { paint: strokeContent, width: layer.vectorStroke?.lineWidth?.value ?? 1 } : undefined;
  if (fill === null || strokeContent === null) return undefined;
  const paths = layer.vectorMask?.paths ?? [];
  if (!paths.length) {
    // A fill layer without a vector mask covers the whole canvas.
    return { ...base, type: "shape", shape: { kind: "rect" }, ...(fill ? { fill } : {}), frame: { x: 0, y: 0, w: origin.w, h: origin.h } } as Layer;
  }
  const points = paths.flatMap((p) => p.knots.flatMap((k) => [[k.points[0]!, k.points[1]!], [k.points[2]!, k.points[3]!], [k.points[4]!, k.points[5]!]]));
  const xs = points.map((p) => p[0]!);
  const ys = points.map((p) => p[1]!);
  const frame = { x: Math.min(...xs) - origin.x, y: Math.min(...ys) - origin.y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const shape = asRect(paths) ? { kind: "rect" } : { kind: "path", d: svgPath(paths, frame.x + origin.x, frame.y + origin.y) };
  if (layer.vectorMask?.invert) ctx.warnings.push(`shape "${base.name}": inverted vector masks aren't supported; imported uninverted`);
  return { ...base, type: "shape", shape, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}), frame: rounded(frame) } as Layer;
}

/** Four corner knots with no curves, on axis-aligned edges: a plain rectangle. */
function asRect(paths: BezierPath[]): boolean {
  if (paths.length !== 1 || paths[0]!.knots.length !== 4) return false;
  const knots = paths[0]!.knots;
  const straight = knots.every((k) => k.points[0] === k.points[2] && k.points[1] === k.points[3] && k.points[4] === k.points[2] && k.points[5] === k.points[3]);
  const xs = new Set(knots.map((k) => round(k.points[2]!, 2)));
  const ys = new Set(knots.map((k) => round(k.points[3]!, 2)));
  return straight && xs.size === 2 && ys.size === 2;
}

function svgPath(paths: BezierPath[], ox: number, oy: number): string {
  const f = (v: number) => round(v, 2);
  const parts: string[] = [];
  for (const path of paths) {
    const k = path.knots;
    if (!k.length) continue;
    const pt = (i: number, j: number) => `${f(k[i]!.points[j]! - ox)} ${f(k[i]!.points[j + 1]! - oy)}`;
    parts.push(`M ${pt(0, 2)}`);
    for (let i = 1; i < k.length; i++) parts.push(`C ${pt(i - 1, 4)} ${pt(i, 0)} ${pt(i, 2)}`);
    if (!path.open) parts.push(`C ${pt(k.length - 1, 4)} ${pt(0, 0)} ${pt(0, 2)} Z`);
  }
  return parts.join(" ");
}

async function convertSmart(layer: PsdLayer, base: Record<string, unknown>, origin: Box, ctx: Ctx): Promise<Layer | undefined> {
  const placed = layer.placedLayer!;
  const file = ctx.linked.get(placed.id);
  if (!file?.data) {
    ctx.warnings.push(`smart object "${base.name}" has no embedded file; imported as pixels`);
    return undefined;
  }
  const symbolId = `${ctx.options.idPrefix ?? ""}so-${slug(file.name ?? placed.id)}`.slice(0, 60);
  if (!ctx.symbols[symbolId]) {
    const isPsd = file.data.length > 4 && String.fromCharCode(...file.data.subarray(0, 4)) === "8BPS";
    if (isPsd) {
      const inner = await importPsd(file.data, {
        ...ctx.options,
        id: symbolId,
        assetDir: join(ctx.options.assetDir, symbolId),
        uriBase: `${ctx.options.uriBase}/${symbolId}`,
        idPrefix: `${ctx.options.idPrefix ?? ""}${symbolId}-`,
      });
      const board = inner.doc.artboards[0]!;
      Object.assign(ctx.assets, inner.doc.assets);
      Object.assign(ctx.symbols, inner.doc.symbols ?? {});
      ctx.warnings.push(...inner.warnings.map((w) => `in smart object "${base.name}": ${w}`));
      ctx.symbols[symbolId] = { id: symbolId, name: file.name?.replace(/\.psd$/i, "") ?? symbolId, size: [board.frame.w, board.frame.h], ...(board.background ? { background: board.background } : {}), layers: board.layers };
    } else {
      const meta = await sharp(file.data).metadata().catch(() => undefined);
      if (!meta?.width || !meta.height) {
        ctx.warnings.push(`smart object "${base.name}" holds a ${file.type ?? "file"} Gesso can't open; imported as pixels`);
        return undefined;
      }
      const assetId = `${symbolId}-image`;
      await writeFile(join(ctx.options.assetDir, `${assetId}.${meta.format === "jpeg" ? "jpg" : meta.format}`), file.data);
      ctx.assets[assetId] = { uri: `${ctx.options.uriBase}/${assetId}.${meta.format === "jpeg" ? "jpg" : meta.format}`, kind: "image", width: meta.width, height: meta.height };
      ctx.symbols[symbolId] = {
        id: symbolId,
        name: file.name ?? symbolId,
        size: [meta.width, meta.height],
        layers: [{ id: "image", name: "Image", type: "image", asset: assetId, fit: "fill", frame: { x: 0, y: 0, w: meta.width, h: meta.height } }],
      };
    }
  }
  const t = placed.nonAffineTransform ?? placed.transform;
  const quad = [0, 1, 2, 3].map((i) => [round(t[i * 2]! - origin.x, 2), round(t[i * 2 + 1]! - origin.y, 2)]) as [[number, number], [number, number], [number, number], [number, number]];
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const frame = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  if (isWarped(placed.warp)) ctx.warnings.push(`smart object "${base.name}": warps aren't supported; placed by its corners`);
  return { ...base, type: "smart", symbol: symbolId, quad, frame: rounded(frame) } as Layer;
}

/** Real warps only: Photoshop also stores an untouched custom mesh, a regular grid, on plain smart objects. */
function isWarped(warp: NonNullable<PsdLayer["placedLayer"]>["warp"]): boolean {
  if (!warp?.style || warp.style === "none") return false;
  if (warp.style !== "custom") return true;
  const mesh = warp.customEnvelopeWarp?.meshPoints;
  const b = warp.bounds;
  if (!mesh || mesh.length !== 16 || !b) return true;
  const [l, t, r, btm] = [b.left.value, b.top.value, b.right.value, b.bottom.value];
  return mesh.some((p, i) => Math.abs(p.x - (l + ((r - l) * (i % 4)) / 3)) > 0.5 || Math.abs(p.y - (t + ((btm - t) * Math.floor(i / 4)) / 3)) > 0.5);
}

function convertAdjustment(adj: NonNullable<PsdLayer["adjustment"]>): Adjustment | undefined {
  if (adj.type === "brightness/contrast") return { kind: "brightness-contrast", brightness: adj.brightness ?? 0, contrast: adj.contrast ?? 0 };
  if (adj.type === "hue/saturation") return { kind: "hue-saturation", hue: adj.master?.hue ?? 0, saturation: adj.master?.saturation ?? 0, lightness: adj.master?.lightness ?? 0 };
  if (adj.type === "curves" && adj.rgb?.length) return { kind: "curves", points: adj.rgb.map((p) => [p.input, p.output] as [number, number]) };
  if (adj.type === "levels" && adj.rgb) {
    const l = adj.rgb;
    return { kind: "levels", inputBlack: l.shadowInput, inputWhite: l.highlightInput, gamma: l.midtoneInput, outputBlack: l.shadowOutput, outputWhite: l.highlightOutput };
  }
  return undefined;
}

function convertEffects(layer: PsdLayer, ctx: Ctx): Effect[] {
  const fx = layer.effects!;
  if (fx.disabled) return [];
  const out: Effect[] = [];
  const on = <T extends { enabled?: boolean }>(list: T[] | T | undefined) => (Array.isArray(list) ? list : list ? [list] : []).filter((e) => e.enabled !== false);
  const spread = (v?: { value: number }) => (v?.value ? { spread: round(v.value / 100, 2) } : {});
  for (const e of on(fx.dropShadow)) {
    out.push({ kind: "drop-shadow", color: hex(e.color), opacity: round(e.opacity ?? 0.75, 3), angle: e.angle ?? 120, distance: e.distance?.value ?? 0, size: e.size?.value ?? 0, ...spread(e.choke) });
  }
  for (const e of on(fx.outerGlow)) out.push({ kind: "outer-glow", color: hex(e.color), opacity: round(e.opacity ?? 0.75, 3), size: e.size?.value ?? 0, ...spread(e.choke) });
  for (const e of on(fx.stroke)) {
    if (e.fillType && e.fillType !== "color") ctx.warnings.push(`layer "${layer.name}": gradient and pattern strokes import as solid colour`);
    out.push({ kind: "stroke", color: hex(e.color), width: e.size?.value ?? 1, position: e.position ?? "outside", ...(e.opacity !== undefined && e.opacity < 1 ? { opacity: round(e.opacity, 3) } : {}) });
  }
  for (const e of on(fx.solidFill)) out.push({ kind: "color-overlay", color: hex(e.color), ...(e.opacity !== undefined && e.opacity < 1 ? { opacity: round(e.opacity, 3) } : {}) });
  const skipped = (["innerShadow", "innerGlow", "bevel", "satin", "gradientOverlay", "patternOverlay"] as const).filter((k) => on(fx[k] as never).length);
  if (skipped.length) ctx.warnings.push(`layer "${layer.name}": ${skipped.join(", ")} effects aren't supported yet; left out`);
  return out;
}

/** Photoshop layer masks have their own bounds and a colour outside them; Gesso masks cover the layer's box. */
async function convertMask(layer: PsdLayer, id: string, bounds: Box, origin: Box, ctx: Ctx) {
  const m = layer.mask!;
  const box = bounds.w > 0 && bounds.h > 0 ? bounds : { x: 0, y: 0, w: origin.w, h: origin.h };
  const fill = m.defaultColor ?? 0;
  const canvas = Buffer.alloc(Math.round(box.w) * Math.round(box.h), fill);
  const data = m.imageData!;
  const mx = (m.left ?? 0) - origin.x - box.x;
  const my = (m.top ?? 0) - origin.y - box.y;
  for (let y = 0; y < data.height; y++) {
    const ty = y + my;
    if (ty < 0 || ty >= box.h) continue;
    for (let x = 0; x < data.width; x++) {
      const tx = x + mx;
      if (tx < 0 || tx >= box.w) continue;
      canvas[ty * Math.round(box.w) + tx] = data.data[(y * data.width + x) * 4]!;
    }
  }
  const assetId = `${ctx.options.idPrefix ?? ""}${id}-mask`;
  const png = await sharp(canvas, { raw: { width: Math.round(box.w), height: Math.round(box.h), channels: 1 } }).png().toBuffer();
  await writeFile(join(ctx.options.assetDir, `${assetId}.png`), png);
  ctx.assets[assetId] = { uri: `${ctx.options.uriBase}/${assetId}.png`, kind: "mask", width: Math.round(box.w), height: Math.round(box.h) };
  if (layer.mask?.disabled) ctx.warnings.push(`layer "${layer.name}": its mask was disabled in Photoshop; imported as enabled`);
  return { kind: "raster", asset: assetId };
}

async function saveImage(id: string, image: NonNullable<PsdLayer["imageData"]>, ctx: Ctx): Promise<string> {
  const assetId = `${ctx.options.idPrefix ?? ""}${id}-pixels`;
  const file = `${assetId}.png`;
  ctx.assets[assetId] = { uri: `${ctx.options.uriBase}/${file}`, kind: "image", width: image.width, height: image.height };
  ctx.pending.push(
    sharp(Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength), { raw: { width: image.width, height: image.height, channels: 4 } })
      .png()
      .toBuffer()
      .then((png) => writeFile(join(ctx.options.assetDir, file), png)),
  );
  return assetId;
}

/** Fill or stroke content as a Gesso paint; null when it's a pattern or noise gradient. */
function paint(content: VectorContent): Paint | null {
  if (content.type === "color") return hex(content.color);
  if (content.type === "solid") {
    const stops = content.colorStops.map((s) => {
      const opacity = nearest(content.opacityStops, s.location)?.opacity ?? 1;
      return { offset: round(s.location, 4), color: hex(s.color, opacity) };
    });
    if (stops.length < 2) return stops[0]?.color ?? null;
    return content.style === "radial" ? { kind: "radial-gradient", stops } : { kind: "linear-gradient", angle: content.angle ?? 90, stops };
  }
  return null;
}

const nearest = <T extends { location: number }>(list: T[], at: number) => list.reduce<T | undefined>((best, s) => (!best || Math.abs(s.location - at) < Math.abs(best.location - at) ? s : best), undefined);

function hex(color: PsdColor | undefined, opacity = 1): string {
  const c = (color ?? { r: 0, g: 0, b: 0 }) as { r?: number; g?: number; b?: number };
  const h = (v: number | undefined) => Math.max(0, Math.min(255, Math.round(v ?? 0))).toString(16).padStart(2, "0").toUpperCase();
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${opacity < 1 ? h(opacity * 255) : ""}`;
}

function uniqueId(name: string, ctx: Ctx, fallback: string, taken = ctx.ids): string {
  const base = slug(name) || fallback;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
const rounded = (b: Box) => ({ x: round(b.x, 2), y: round(b.y, 2), w: round(b.w, 2), h: round(b.h, 2) });

