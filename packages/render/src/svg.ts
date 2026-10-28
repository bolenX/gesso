import type { Artboard, Doc, Layer, Paint } from "@gesso/core";
import { isComputedMask, isKeyMask, isStandardBlend, paintColor } from "@gesso/core";
import sharp from "sharp";
import { defaultAssetLoader, type AssetLoader } from "./assets.js";
import { extractFace } from "./fonts.js";
import { resolveFrame, type Box } from "./layout.js";
import { encode, layerTransform, renderArtboard, renderLayerParts, type LayerPart } from "./render.js";

// SVG export. Everything SVG can express stays vector and editable: shapes, gradients, strokes,
// images, groups, opacity, blend modes, rotation, vector masks, and text as real <text> (with
// line breaks from Gesso's own layout, so it wraps the same) or <textPath>. What it can't
// (filters, layer effects, mesh gradients, raster masks, perspective smart objects) is drawn
// by the renderer and embedded as an image of just that layer. Layers below an adjustment or a
// background blur, which depend on everything beneath them, are flattened into one image.

export type SvgOptions = {
  loader?: AssetLoader;
  embedFonts?: boolean;
  /**
   * "pdf" writes SVG for PDF conversion, which has no blend modes or SVG filters and takes only
   * PNG and JPEG: blended layers are flattened, feathered masks rendered, other images re-encoded.
   */
  target?: "browser" | "pdf";
};
export type SvgResult = { svg: string; warnings: string[] };

type Ctx = {
  pdf: boolean;
  doc: Doc;
  artboard: Artboard;
  parts: Map<string, LayerPart>;
  loader: AssetLoader;
  defs: string[];
  fonts: Set<string>;
  warnings: string[];
  ids: number;
};

export async function writeSvg(doc: Doc, artboardId: string, options: SvgOptions = {}): Promise<SvgResult> {
  const artboard = doc.artboards.find((a) => a.id === artboardId);
  if (!artboard) throw new Error(`No artboard "${artboardId}"`);
  const loader = options.loader ?? defaultAssetLoader();
  const { parts, warnings } = await renderLayerParts(doc, artboardId, { loader });
  const pdf = options.target === "pdf";
  const ctx: Ctx = { pdf, doc, artboard, parts, loader, defs: [], fonts: new Set(), warnings: [...warnings], ids: 0 };
  const { w, h } = artboard.frame;
  const body: string[] = [];

  // Everything up to the last layer that needs to see what's beneath it is flattened.
  const layers = artboard.layers;
  let flatten = -1;
  layers.forEach((layer, i) => {
    if (needsBackdrop(layer, pdf) || (layer.clip && i > 0)) flatten = i;
  });
  if (flatten >= 0) {
    const below = { ...doc, artboards: [{ ...artboard, layers: layers.slice(0, flatten + 1) }] };
    const flat = await renderArtboard(below, artboardId, { loader });
    body.push(`<image x="0" y="0" width="${w}" height="${h}" href="${dataUri("image/png", await encode(flat, "png"))}"><title>Flattened: ${esc(layers.slice(0, flatten + 1).map((l) => l.name).join(", "))}</title></image>`);
    ctx.warnings.push(`layers up to "${layers[flatten]!.name}" are flattened into one image, because an adjustment, background blur, clipping${pdf ? " or blend mode (PDF has none)" : ""} needs what's beneath it`);
  } else if (artboard.background) {
    body.push(`<rect x="0" y="0" width="${w}" height="${h}" fill="${paintRef(artboard.background, { x: 0, y: 0, w, h }, ctx)}"/>`);
  }
  for (const layer of layers.slice(flatten + 1)) body.push(await element(layer, ctx));

  const style = options.embedFonts === false || pdf ? "" : await fontFaces(ctx);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<title>${esc(artboard.name)}</title>`,
    `<metadata>Made with Gesso, ${esc(doc.id)} revision ${doc.revision}</metadata>`,
    ctx.defs.length || style ? `<defs>${style}${ctx.defs.join("")}</defs>` : "",
    ...body,
    "</svg>",
  ].join("\n");
  return { svg, warnings: ctx.warnings };
}

/** Layers whose pixels depend on what's beneath them (in a PDF, blend modes too). */
function needsBackdrop(layer: Layer, pdf = false): boolean {
  if (layer.type === "adjustment") return true;
  if (layer.effects?.some((e) => e.kind === "background-blur")) return true;
  if (pdf && layer.blend && layer.blend !== "normal") return true;
  // CSS has the standard blend modes only; Photoshop's others are rendered with what's below.
  if (!isStandardBlend(layer.blend)) return true;
  // Blend If and masks computed from what's below read the pixels beneath.
  if (layer.blendIf) return true;
  if (isComputedMask(layer.mask) && !isKeyMask(layer.mask) && (layer.mask.kind === "calculations" ? [layer.mask.a.source, layer.mask.b.source] : [layer.mask.source]).some((s) => (s ?? "below") === "below")) return true;
  return layer.type === "group" && layer.children.some((c) => needsBackdrop(c, pdf));
}

/** True when the layer (or something inside it) has to be drawn by the renderer. */
function needsRaster(layer: Layer, pdf = false): boolean {
  if (layer.filters?.length || layer.effects?.length) return true;
  // Refined and stroked masks, like raster and computed ones, are drawn as pixels.
  if (layer.mask && (layer.mask.kind !== "vector" || layer.mask.shape.kind === "compound" || layer.mask.stroke || layer.mask.refine || (pdf && layer.mask.feather))) return true;
  if (layer.type === "smart" || layer.quad || layer.warp) return true;
  if (layer.type === "image" && layer.fit === "content-aware") return true;
  if (layer.type === "shape" && (isMesh(layer.fill) || isMesh(layer.stroke?.paint))) return true;
  if (layer.type === "group") return layer.children.some((c, i) => needsRaster(c, pdf) || needsBackdrop(c, pdf) || (c.clip && i > 0));
  return false;
}

const isMesh = (paint: Paint | undefined) => typeof paint === "object" && paint.kind === "mesh-gradient";

async function element(layer: Layer, ctx: Ctx): Promise<string> {
  const part = ctx.parts.get(layer.id);
  if (!part) return "";
  if (needsRaster(layer, ctx.pdf)) return raster(layer, part, ctx);

  let inner: string;
  switch (layer.type) {
    case "shape":
      inner = shape(layer, part.box, ctx);
      break;
    case "image":
      inner = await image(layer, part.box, ctx);
      break;
    case "text":
      inner = text(layer, part, ctx);
      break;
    case "group": {
      const children: string[] = [];
      for (const child of layer.children) children.push(await element(child, ctx));
      inner = children.join("\n");
      break;
    }
    default:
      return "";
  }
  return wrap(layer, part, inner, ctx);
}

/** The layer's own attributes around its content: id, opacity, blend, visibility, transform, mask. */
function wrap(layer: Layer, part: LayerPart, inner: string, ctx: Ctx): string {
  const attrs = [`id="${esc(layer.id)}"`, `data-name="${esc(layer.name)}"`];
  const style: string[] = [];
  if (layer.opacity !== undefined && layer.opacity < 1) attrs.push(`opacity="${layer.opacity}"`);
  if (layer.blend && layer.blend !== "normal") style.push(`mix-blend-mode:${layer.blend}`);
  if (layer.type === "group" && layer.isolation === "isolate") style.push("isolation:isolate");
  if (layer.visible === false) attrs.push(`display="none"`);
  const m = layerTransform(layer, part.box);
  if (m) attrs.push(`transform="matrix(${m.map(num).join(" ")})"`);
  if (layer.mask?.kind === "vector") attrs.push(`mask="url(#${vectorMask(layer.mask, part.box, ctx)})"`);
  if (style.length) attrs.push(`style="${style.join(";")}"`);
  return `<g ${attrs.join(" ")}>${inner}</g>`;
}

function shape(layer: Extract<Layer, { type: "shape" }>, box: Box, ctx: Ctx): string {
  const fill = layer.fill === undefined ? "none" : paintRef(layer.fill, box, ctx);
  const attrs = [`fill="${fill}"`];
  if (layer.fillOpacity !== undefined && layer.fillOpacity < 1) attrs.push(`fill-opacity="${layer.fillOpacity}"`);
  if (layer.stroke) {
    attrs.push(`stroke="${paintRef(layer.stroke.paint, box, ctx)}"`, `stroke-width="${num(layer.stroke.width)}"`);
    if (layer.stroke.cap) attrs.push(`stroke-linecap="${layer.stroke.cap}"`);
    if (layer.stroke.join) attrs.push(`stroke-linejoin="${layer.stroke.join}"`);
  }
  const combined = layer.shape.kind === "compound" ? ctx.parts.get(layer.id)?.svgPath : undefined;
  if (combined !== undefined) return `<path d="${esc(combined)}" ${attrs.join(" ")}/>`;
  return shapeElement(layer.shape, box, attrs.join(" "));
}

function shapeElement(s: Extract<Layer, { type: "shape" }>["shape"], box: Box, attrs: string): string {
  if (s.kind === "rect") {
    const r = Math.min(s.radius ?? 0, box.w / 2, box.h / 2);
    return `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}"${r ? ` rx="${num(r)}"` : ""} ${attrs}/>`;
  }
  if (s.kind === "ellipse") return `<ellipse cx="${num(box.x + box.w / 2)}" cy="${num(box.y + box.h / 2)}" rx="${num(box.w / 2)}" ry="${num(box.h / 2)}" ${attrs}/>`;
  if (s.kind === "compound") return ""; // drawn from its combined outline (see shape) or rendered
  return `<path d="${esc(s.d)}" transform="translate(${num(box.x)} ${num(box.y)})" ${attrs}/>`;
}

async function image(layer: Extract<Layer, { type: "image" }>, box: Box, ctx: Ctx): Promise<string> {
  const asset = ctx.doc.assets[layer.asset]!;
  let bytes = await ctx.loader(asset);
  const meta = await sharp(bytes).metadata();
  const [iw, ih] = [meta.width ?? 1, meta.height ?? 1];
  let format = meta.format === "jpg" ? "jpeg" : meta.format;
  if (ctx.pdf && format !== "jpeg" && format !== "png") {
    bytes = await sharp(bytes).png().toBuffer();
    format = "png";
  }
  const href = dataUri(`image/${format}`, bytes);
  const fit = layer.fit ?? "cover";
  const [fx, fy] = layer.focus ?? [0.5, 0.5];
  // The same crop the renderer makes: a nested viewport showing the chosen part of the image.
  if (fit === "cover") {
    const s = Math.max(box.w / iw, box.h / ih);
    const [cw, ch] = [box.w / s, box.h / s];
    return `<svg x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" viewBox="${num((iw - cw) * fx)} ${num((ih - ch) * fy)} ${num(cw)} ${num(ch)}" preserveAspectRatio="none"><image width="${iw}" height="${ih}" href="${href}"/></svg>`;
  }
  return `<image x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" preserveAspectRatio="${fit === "contain" ? "xMidYMid meet" : "none"}" href="${href}"/>`;
}

function text(layer: Extract<Layer, { type: "text" }>, part: LayerPart, ctx: Ctx): string {
  const { style } = layer;
  const size = part.fontSize ?? style.size;
  const k = size / style.size;
  ctx.fonts.add(style.font);
  const attrs = [
    `font-family="${esc(style.font)}"`,
    `font-size="${num(size)}"`,
    `fill="${style.fill === undefined ? "#000000" : esc(colorOf(paintColor(style.fill)))}"`,
    ...(alphaOf(style.fill === undefined ? "#000000" : paintColor(style.fill)) < 1 ? [`fill-opacity="${alphaOf(paintColor(style.fill!))}"`] : []),
    ...(style.weight && style.weight !== 400 ? [`font-weight="${style.weight}"`] : []),
    ...(style.tracking ? [`letter-spacing="${num((style.tracking / 1000) * size)}"`] : []),
    `xml:space="preserve"`,
  ];
  const runSpan = (run: NonNullable<typeof layer.runs>[number], piece: string) => {
    if (run.font) ctx.fonts.add(run.font);
    const a = [
      ...(run.font ? [`font-family="${esc(run.font)}"`] : []),
      ...(run.size ? [`font-size="${num(run.size * k)}"`] : []),
      ...(run.weight ? [`font-weight="${run.weight}"`] : []),
      ...(run.fill ? [`fill="${colorOf(run.fill)}"`] : []),
      ...(run.tracking !== undefined ? [`letter-spacing="${num((run.tracking / 1000) * (run.size ?? style.size) * k)}"`] : []),
    ];
    return a.length ? `<tspan ${a.join(" ")}>${esc(piece)}</tspan>` : esc(piece);
  };
  // Run boundaries as UTF-16 offsets into content.
  const runs = layer.runs ?? [{ text: layer.content }];
  const spans = (from: number, to: number) => {
    let at = 0;
    const out: string[] = [];
    for (const run of runs) {
      const [s, e] = [Math.max(from, at), Math.min(to, at + run.text.length)];
      if (s < e) out.push(runSpan(run, layer.content.slice(s, e)));
      at += run.text.length;
    }
    return out.join("");
  };

  if (layer.path) {
    const id = `gesso-path-${++ctx.ids}`;
    const box = part.box;
    ctx.defs.push(`<path id="${id}" d="${esc(layer.path.d)}" transform="translate(${num(box.x)} ${num(box.y)})"/>`);
    const align = style.align ?? "start";
    const anchor = align === "center" ? "middle" : align === "end" ? "end" : "start";
    const offset = align === "center" ? "50%" : align === "end" ? "100%" : num(layer.path.offset ?? 0);
    return `<text ${attrs.join(" ")} text-anchor="${anchor}"><textPath href="#${id}" startOffset="${offset}">${spans(0, layer.content.length)}</textPath></text>`;
  }
  const lines = (part.lines ?? []).map(
    (line) => `<tspan x="${num(line.left)}" y="${num(line.baseline)}">${spans(line.start, line.end)}</tspan>`,
  );
  return `<text ${attrs.join(" ")}>${lines.join("")}</text>`;
}

/** An SVG mask for a vector mask: the shape (or everything but it, inverted), feathered with a blur. */
function vectorMask(mask: Extract<NonNullable<Layer["mask"]>, { kind: "vector" }>, box: Box, ctx: Ctx): string {
  const id = `gesso-mask-${++ctx.ids}`;
  const at = mask.frame ? resolveFrame(mask.frame, box) : box;
  let filter = "";
  if (mask.feather) {
    const fid = `${id}-feather`;
    ctx.defs.push(`<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${num(mask.feather)}"/></filter>`);
    filter = ` filter="url(#${fid})"`;
  }
  const shapeAttrs = `fill="${mask.invert ? "#000" : "#fff"}"`;
  const background = mask.invert ? `<rect x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" fill="#fff"/>` : "";
  ctx.defs.push(`<mask id="${id}" maskUnits="userSpaceOnUse"><g${filter}>${background}${shapeElement(mask.shape, at, shapeAttrs)}</g></mask>`);
  return id;
}

/** A colour, or a reference to a gradient definition built for this box. */
function paintRef(paint: Paint, box: Box, ctx: Ctx): string {
  if (typeof paint === "string") return colorOf(paint);
  if (paint.kind === "mesh-gradient") return colorOf(paintColor(paint));
  const id = `gesso-gradient-${++ctx.ids}`;
  const stops = paint.stops
    .map((s) => `<stop offset="${num(s.offset)}" stop-color="${colorOf(s.color)}"${alphaOf(s.color) < 1 ? ` stop-opacity="${num(alphaOf(s.color))}"` : ""}/>`)
    .join("");
  const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2];
  if (paint.kind === "linear-gradient") {
    // Same geometry as the renderer: 0° runs left to right, 90° bottom to top.
    const a = (paint.angle * Math.PI) / 180;
    const [dx, dy] = [Math.cos(a), -Math.sin(a)];
    const half = (Math.abs(box.w * dx) + Math.abs(box.h * dy)) / 2;
    ctx.defs.push(
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(cx - dx * half)}" y1="${num(cy - dy * half)}" x2="${num(cx + dx * half)}" y2="${num(cy + dy * half)}">${stops}</linearGradient>`,
    );
  } else {
    ctx.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(cx)}" cy="${num(cy)}" r="${num(Math.max(box.w, box.h) / 2)}">${stops}</radialGradient>`);
  }
  return `url(#${id})`;
}

/**
 * A layer the renderer has to draw: rendered on its own (with its effects, filters and mask, at
 * full opacity and normal blend, which the SVG applies), cropped to its pixels.
 */
async function raster(layer: Layer, part: LayerPart, ctx: Ctx): Promise<string> {
  const alone: Layer = { ...layer, frame: { x: part.box.x, y: part.box.y, w: part.box.w, h: part.box.h }, opacity: undefined, blend: undefined, clip: undefined, visible: true } as Layer;
  const doc = { ...ctx.doc, artboards: [{ ...ctx.artboard, background: undefined, layers: [alone] }] };
  const rendered = await renderArtboard(doc, ctx.artboard.id, { loader: ctx.loader });
  const crop = bounds(rendered.pixels, rendered.width, rendered.height);
  if (!crop) return "";
  const png = await sharp(Buffer.from(rendered.pixels), { raw: { width: rendered.width, height: rendered.height, channels: 4 } })
    .extract({ left: crop.x, top: crop.y, width: crop.w, height: crop.h })
    .png()
    .toBuffer();
  const attrs = [`id="${esc(layer.id)}"`, `data-name="${esc(layer.name)}"`];
  const style: string[] = [];
  if (layer.opacity !== undefined && layer.opacity < 1) attrs.push(`opacity="${layer.opacity}"`);
  if (layer.blend && layer.blend !== "normal") style.push(`mix-blend-mode:${layer.blend}`);
  if (layer.visible === false) attrs.push(`display="none"`);
  if (style.length) attrs.push(`style="${style.join(";")}"`);
  return `<image ${attrs.join(" ")} x="${crop.x}" y="${crop.y}" width="${crop.w}" height="${crop.h}" href="${dataUri("image/png", png)}"/>`;
}

async function fontFaces(ctx: Ctx): Promise<string> {
  const faces: string[] = [];
  for (const family of ctx.fonts) {
    const asset = Object.values(ctx.doc.assets).find((a) => a.kind === "font" && a.family === family);
    if (!asset) continue;
    try {
      const bytes = extractFace(await ctx.loader(asset), asset.face ?? 0);
      const format = String.fromCharCode(...bytes.subarray(0, 4)) === "OTTO" ? "opentype" : "truetype";
      faces.push(`@font-face{font-family:"${family.replace(/"/g, "")}";src:url(${dataUri(`font/${format === "opentype" ? "otf" : "ttf"}`, bytes)}) format("${format}");}`);
    } catch {
      ctx.warnings.push(`font "${family}" couldn't be embedded; the SVG names it, so it shows where that font is installed`);
    }
  }
  return faces.length ? `<style>${faces.join("")}</style>` : "";
}

function bounds(pixels: Uint8Array, w: number, h: number) {
  let [minX, minY, maxX, maxY] = [w, h, -1, -1];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (pixels[(y * w + x) * 4 + 3]! > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? undefined : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

const dataUri = (mime: string, bytes: Uint8Array) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
const colorOf = (c: string) => c.slice(0, 7).toUpperCase();
const alphaOf = (c: string) => (c.length === 9 ? parseInt(c.slice(7), 16) / 255 : 1);
const num = (v: number) => String(Math.round(v * 1000) / 1000);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
