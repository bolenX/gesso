import type {
  Artboard,
  BlendMode,
  Doc,
  ImageLayer,
  Layer,
  Mask,
  Paint as GessoPaint,
  Shape,
  SmartLayer,
  SmartObject,
  TextLayer,
} from "@gesso/core";
import type { CanvasKit, Canvas, Image, Paint, Paragraph, Surface, TypefaceFontProvider } from "canvaskit-wasm";
import sharp from "sharp";
import { applyAdjustment } from "./adjust.js";
import { defaultAssetLoader, type AssetLoader } from "./assets.js";
import { loadCanvasKit } from "./canvaskit.js";
import { resolveFrame, type Box } from "./layout.js";
import { rectToQuad } from "./perspective.js";

// The evaluator. Composites each group bottom up, following docs/spec-v0.1.md,
// "Compositing order within a group": content, smart filters, mask, then clip
// groups, adjustments or a plain blend onto the backdrop. Surfaces are 8-bit
// sRGB, so blending happens in gamma-encoded space like Photoshop.
// Per-node caching (the render DAG) comes later; this renders every layer.

export type RenderOptions = { scale?: number; loader?: AssetLoader };
export type Rendered = { artboard: string; width: number; height: number; pixels: Uint8Array; warnings: string[] };
export type EncodeFormat = "png" | "jpeg" | "webp";

/** One layer rendered on its own, for encoders such as PSD that store layers separately. */
export type LayerPart = {
  id: string;
  /** Resolved box in artboard pixels. */
  box: Box;
  /** Content plus smart filters, without mask, opacity or blend. Absent for groups and adjustments. */
  pixels?: Uint8Array;
  /** Mask coverage, one byte per pixel. */
  mask?: Uint8Array;
  /** Font size after shrink-to-fit, for text layers. */
  fontSize?: number;
  /** Corner pin in artboard pixels (TL, TR, BR, BL), for smart layers. */
  quad?: Array<[number, number]>;
};
export type LayerParts = { width: number; height: number; parts: Map<string, LayerPart>; warnings: string[] };

const BLEND: Record<BlendMode, keyof CanvasKit["BlendMode"]> = {
  normal: "SrcOver",
  multiply: "Multiply",
  screen: "Screen",
  overlay: "Overlay",
  darken: "Darken",
  lighten: "Lighten",
  "color-dodge": "ColorDodge",
  "color-burn": "ColorBurn",
  "hard-light": "HardLight",
  "soft-light": "SoftLight",
  difference: "Difference",
  exclusion: "Exclusion",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
};

export async function renderArtboard(doc: Doc, artboardId: string, options: RenderOptions = {}): Promise<Rendered> {
  const artboard = doc.artboards.find((a) => a.id === artboardId);
  if (!artboard) throw new Error(`No artboard "${artboardId}"`);
  const ck = await loadCanvasKit();
  const resources = await loadResources(ck, doc, [artboard], options.loader ?? defaultAssetLoader());
  try {
    return new Compositor(ck, resources, options.scale ?? 1, doc.symbols ?? {}).render(artboard);
  } finally {
    resources.dispose();
  }
}

export async function renderDoc(doc: Doc, options: RenderOptions = {}): Promise<Rendered[]> {
  const results: Rendered[] = [];
  for (const artboard of doc.artboards) results.push(await renderArtboard(doc, artboard.id, options));
  return results;
}

/** Renders every layer of an artboard separately, at scale 1. */
export async function renderLayerParts(doc: Doc, artboardId: string, options: Omit<RenderOptions, "scale"> = {}): Promise<LayerParts> {
  const artboard = doc.artboards.find((a) => a.id === artboardId);
  if (!artboard) throw new Error(`No artboard "${artboardId}"`);
  const ck = await loadCanvasKit();
  const resources = await loadResources(ck, doc, [artboard], options.loader ?? defaultAssetLoader());
  try {
    return new Compositor(ck, resources, 1, doc.symbols ?? {}).parts(artboard);
  } finally {
    resources.dispose();
  }
}

/** Encodes rendered pixels. Sharp handles encoding so every format shares one path. */
export async function encode(rendered: Rendered, format: EncodeFormat = "png", quality = 90, xmp?: string): Promise<Buffer> {
  let image = sharp(Buffer.from(rendered.pixels), {
    raw: { width: rendered.width, height: rendered.height, channels: 4 },
  });
  if (xmp) image = image.withXmp(xmp);
  if (format === "jpeg") return image.flatten({ background: "#ffffff" }).jpeg({ quality }).toBuffer();
  if (format === "webp") return image.webp({ quality }).toBuffer();
  return image.png().toBuffer();
}

type Resources = {
  images: Map<string, Image>;
  fonts: TypefaceFontProvider;
  families: Set<string>;
  dispose(): void;
};

async function loadResources(ck: CanvasKit, doc: Doc, artboards: Artboard[], loader: AssetLoader): Promise<Resources> {
  const used = new Set<string>();
  const visit = (layers: Layer[]) => {
    for (const layer of layers) {
      if (layer.type === "image") used.add(layer.asset);
      if (layer.mask?.kind === "raster") used.add(layer.mask.asset);
      if (layer.type === "group") visit(layer.children);
      if (layer.type === "smart" && doc.symbols?.[layer.symbol]) visit(doc.symbols[layer.symbol]!.layers);
    }
  };
  for (const artboard of artboards) visit(artboard.layers);

  const images = new Map<string, Image>();
  for (const id of used) {
    const asset = doc.assets[id];
    if (!asset) throw new Error(`Missing asset "${id}"`);
    const { data, info } = await sharp(await loader(asset))
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const image = ck.MakeImage(
      {
        width: info.width,
        height: info.height,
        colorType: ck.ColorType.RGBA_8888,
        alphaType: ck.AlphaType.Unpremul,
        colorSpace: ck.ColorSpace.SRGB,
      },
      data,
      info.width * 4,
    );
    if (!image) throw new Error(`Could not decode asset "${id}"`);
    images.set(id, image);
  }

  const fonts = ck.TypefaceFontProvider.Make();
  const families = new Set<string>();
  for (const asset of Object.values(doc.assets)) {
    if (asset.kind !== "font") continue;
    if (!asset.family) throw new Error(`Font asset ${asset.uri} needs a "family"`);
    fonts.registerFont(await loader(asset), asset.family);
    families.add(asset.family);
  }

  return {
    images,
    fonts,
    families,
    dispose() {
      for (const image of images.values()) image.delete();
      fonts.delete();
    },
  };
}

class Compositor {
  private width = 0;
  private height = 0;
  warnings: string[] = [];
  private byId = new Map<string, Layer>();
  private fittedSizes = new Map<string, number>();

  constructor(
    private ck: CanvasKit,
    private res: Resources,
    private scale: number,
    private symbols: Record<string, SmartObject>,
  ) {}

  render(artboard: Artboard): Rendered {
    this.width = Math.max(1, Math.round(artboard.frame.w * this.scale));
    this.height = Math.max(1, Math.round(artboard.frame.h * this.scale));
    this.index(artboard.layers);

    const target = this.surface();
    const box = { x: 0, y: 0, w: artboard.frame.w, h: artboard.frame.h };
    if (artboard.background) {
      this.drawScaled(target.getCanvas(), (c) => c.drawRect(this.ck.XYWHRect(0, 0, box.w, box.h), this.paint(artboard.background!, box)));
    }
    this.composite(artboard.layers, box, target);
    const pixels = this.readPixels(target);
    target.delete();
    return { artboard: artboard.id, width: this.width, height: this.height, pixels, warnings: this.warnings };
  }

  parts(artboard: Artboard): LayerParts {
    this.width = Math.max(1, Math.round(artboard.frame.w));
    this.height = Math.max(1, Math.round(artboard.frame.h));
    this.index(artboard.layers);
    const parts = new Map<string, LayerPart>();
    const visit = (layers: Layer[], parent: Box) => {
      for (const layer of layers) {
        const part: LayerPart = { id: layer.id, box: resolveFrame(layer.frame, parent) };
        if (layer.type !== "group" && layer.type !== "adjustment") {
          const s = this.surface();
          part.box = this.drawContent(layer, parent, s);
          let image = s.makeImageSnapshot();
          s.delete();
          for (const filter of layer.filters ?? []) {
            if (filter.kind === "gaussian-blur") image = this.blur(image, filter.radius);
          }
          part.pixels = image.readPixels(0, 0, this.info(this.ck.AlphaType.Unpremul)) as Uint8Array;
          image.delete();
          const fitted = this.fittedSizes.get(layer.id);
          if (fitted !== undefined) part.fontSize = fitted;
          if (layer.type === "smart") {
            const b = part.box;
            part.quad = layer.quad
              ? layer.quad.map(([x, y]) => [parent.x + x, parent.y + y] as [number, number])
              : [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
          }
        }
        if (layer.mask) part.mask = this.readImageAlpha(this.maskImage(layer.mask, part.box, parent));
        parts.set(layer.id, part);
        if (layer.type === "group") visit(layer.children, part.box);
      }
    };
    visit(artboard.layers, { x: 0, y: 0, w: artboard.frame.w, h: artboard.frame.h });
    return { width: this.width, height: this.height, parts, warnings: this.warnings };
  }

  private index(layers: Layer[]): void {
    for (const layer of layers) {
      this.byId.set(layer.id, layer);
      if (layer.type === "group") this.index(layer.children);
    }
  }

  /** Composites a layer list (bottom to top) onto target. */
  private composite(layers: Layer[], parent: Box, target: Surface): void {
    for (let i = 0; i < layers.length; i++) {
      const base = layers[i]!;
      let end = i + 1;
      while (end < layers.length && layers[end]!.clip) end++;
      const clipped = base.clip ? [] : layers.slice(i + 1, end);
      if (!base.clip) i = end - 1;
      if (base.visible === false) continue; // a hidden base hides its clipped layers too, as in Photoshop

      if (base.type === "adjustment") {
        this.adjust(base, parent, target, null);
        continue;
      }
      if (base.type === "group" && clipped.length === 0 && this.isPlainPassThrough(base)) {
        this.composite(base.children, resolveFrame(base.frame, parent), target);
        continue;
      }

      const content = this.renderLayer(base, parent);
      if (clipped.length === 0) {
        this.drawImage(target, content, base.blend, base.opacity);
        content.delete();
        continue;
      }

      const group = this.surface();
      group.getCanvas().drawImage(content, 0, 0);
      for (const layer of clipped) {
        if (layer.visible === false) continue;
        if (layer.type === "adjustment") {
          this.adjust(layer, parent, group, content);
          continue;
        }
        const s = this.surface();
        const image = this.renderLayer(layer, parent);
        s.getCanvas().drawImage(image, 0, 0);
        image.delete();
        this.drawImage(s, content, undefined, 1, "DstIn");
        const clippedImage = s.makeImageSnapshot();
        s.delete();
        this.drawImage(group, clippedImage, layer.blend, layer.opacity);
        clippedImage.delete();
      }
      const groupImage = group.makeImageSnapshot();
      group.delete();
      this.drawImage(target, groupImage, base.blend, base.opacity);
      groupImage.delete();
      content.delete();
    }
  }

  private isPlainPassThrough(group: Extract<Layer, { type: "group" }>): boolean {
    return (
      (group.isolation ?? "pass-through") === "pass-through" &&
      (group.opacity ?? 1) === 1 &&
      (group.blend ?? "normal") === "normal" &&
      !group.mask &&
      !group.filters?.length
    );
  }

  /** Renders one layer's content, smart filters and mask onto a transparent artboard-sized image. */
  private renderLayer(layer: Layer, parent: Box, withMask = true): Image {
    const s = this.surface();
    const box = this.drawContent(layer, parent, s);
    let image = s.makeImageSnapshot();
    s.delete();

    for (const filter of layer.filters ?? []) {
      if (filter.kind === "gaussian-blur") image = this.blur(image, filter.radius);
    }
    if (withMask && layer.mask) {
      const mask = this.maskImage(layer.mask, box, parent);
      const out = this.surface();
      out.getCanvas().drawImage(image, 0, 0);
      this.drawImage(out, mask, undefined, 1, "DstIn");
      mask.delete();
      image.delete();
      image = out.makeImageSnapshot();
      out.delete();
    }
    return image;
  }

  private drawContent(layer: Layer, parent: Box, s: Surface): Box {
    const canvas = s.getCanvas();
    switch (layer.type) {
      case "shape": {
        const box = resolveFrame(layer.frame, parent);
        this.drawScaled(canvas, (c) => {
          if (layer.fill) this.drawShape(c, layer.shape, box, this.paint(layer.fill, box));
          if (layer.stroke) {
            const p = this.paint(layer.stroke.paint, box);
            p.setStyle(this.ck.PaintStyle.Stroke);
            p.setStrokeWidth(layer.stroke.width);
            this.drawShape(c, layer.shape, box, p);
          }
        });
        return box;
      }
      case "image":
        return this.drawImageLayer(layer, parent, canvas);
      case "text":
        return this.drawText(layer, parent, canvas);
      case "group": {
        const box = resolveFrame(layer.frame, parent);
        this.composite(layer.children, box, s);
        return box;
      }
      case "adjustment":
        return resolveFrame(layer.frame, parent);
      case "smart":
        return this.drawSmart(layer, parent, canvas);
    }
  }

  /** Renders the symbol on its own surface, then places it: corner-pinned by quad, or filling the frame. */
  private drawSmart(layer: SmartLayer, parent: Box, canvas: Canvas): Box {
    const symbol = this.symbols[layer.symbol];
    if (!symbol) throw new Error(`Layer "${layer.id}" places missing symbol "${layer.symbol}"`);
    const [w, h] = symbol.size;
    const sub = new Compositor(this.ck, this.res, this.scale, this.symbols);
    const rendered = sub.renderSymbol(symbol);
    this.warnings.push(...sub.warnings.map((m) => `symbol "${symbol.id}": ${m}`));
    const image = this.ck.MakeImage(this.info(this.ck.AlphaType.Unpremul, rendered.width, rendered.height), rendered.pixels, rendered.width * 4)!;

    const quad = layer.quad?.map(([x, y]) => [parent.x + x, parent.y + y] as [number, number]) as
      | [[number, number], [number, number], [number, number], [number, number]]
      | undefined;
    const box = quad ? quadBounds(quad) : resolveFrame(layer.frame, parent, { aspect: w / h });
    const target = quad ?? [
      [box.x, box.y],
      [box.x + box.w, box.y],
      [box.x + box.w, box.y + box.h],
      [box.x, box.y + box.h],
    ];
    const matrix = rectToQuad(rendered.width, rendered.height, target as [[number, number], [number, number], [number, number], [number, number]]);
    this.drawScaled(canvas, (c) => {
      c.save();
      c.concat(matrix);
      const p = new this.ck.Paint();
      p.setAntiAlias(true);
      const rect = this.ck.XYWHRect(0, 0, rendered.width, rendered.height);
      c.drawImageRectOptions(image, rect, rect, this.ck.FilterMode.Linear, this.ck.MipmapMode.Linear, p);
      p.delete();
      c.restore();
    });
    image.delete();
    return box;
  }

  renderSymbol(symbol: SmartObject): Rendered {
    this.width = Math.max(1, Math.round(symbol.size[0] * this.scale));
    this.height = Math.max(1, Math.round(symbol.size[1] * this.scale));
    this.index(symbol.layers);
    const target = this.surface();
    const box = { x: 0, y: 0, w: symbol.size[0], h: symbol.size[1] };
    if (symbol.background) {
      this.drawScaled(target.getCanvas(), (c) => c.drawRect(this.ck.XYWHRect(0, 0, box.w, box.h), this.paint(symbol.background!, box)));
    }
    this.composite(symbol.layers, box, target);
    const pixels = this.readPixels(target);
    target.delete();
    return { artboard: symbol.id, width: this.width, height: this.height, pixels, warnings: this.warnings };
  }

  private drawImageLayer(layer: ImageLayer, parent: Box, canvas: Canvas): Box {
    const image = this.res.images.get(layer.asset)!;
    const iw = image.width();
    const ih = image.height();
    const box = resolveFrame(layer.frame, parent, { aspect: iw / ih });
    const fit = layer.fit ?? "cover";
    const [fx, fy] = layer.focus ?? [0.5, 0.5];
    let src = this.ck.XYWHRect(0, 0, iw, ih);
    let dst = this.ck.XYWHRect(box.x, box.y, box.w, box.h);
    if (fit === "cover") {
      const s = Math.max(box.w / iw, box.h / ih);
      const cw = box.w / s;
      const chh = box.h / s;
      src = this.ck.XYWHRect((iw - cw) * fx, (ih - chh) * fy, cw, chh);
    } else if (fit === "contain") {
      const s = Math.min(box.w / iw, box.h / ih);
      const w = iw * s;
      const h = ih * s;
      dst = this.ck.XYWHRect(box.x + (box.w - w) / 2, box.y + (box.h - h) / 2, w, h);
    }
    this.drawScaled(canvas, (c) => {
      const p = new this.ck.Paint();
      c.drawImageRectOptions(image, src, dst, this.ck.FilterMode.Linear, this.ck.MipmapMode.Linear, p);
      p.delete();
    });
    return box;
  }

  private drawText(layer: TextLayer, parent: Box, canvas: Canvas): Box {
    const { style } = layer;
    if (!this.res.families.has(style.font)) {
      this.warnings.push(`text "${layer.id}": font "${style.font}" is not loaded; add it as a font asset`);
    }
    const isArea = layer.box?.kind !== "point";
    const area = isArea ? resolveFrame(layer.frame, parent, {}) : undefined;
    const fixedHeight = "anchor" in layer.frame ? layer.frame.h !== undefined : true;

    let size = style.size;
    let para = this.paragraph(layer, size, area?.w);
    if (area && layer.box?.kind === "area" && layer.box.shrinkToFit && fixedHeight) {
      const min = layer.box.minSize ?? Math.min(8, size);
      while (para.getHeight() > area.h && size > min) {
        para.delete();
        size = Math.max(min, size - 1);
        para = this.paragraph(layer, size, area.w);
      }
    }
    const measured = { w: Math.ceil(para.getMaxIntrinsicWidth()), h: Math.ceil(para.getHeight()) };
    const box = isArea
      ? resolveFrame(layer.frame, parent, fixedHeight ? {} : { h: measured.h })
      : resolveFrame(layer.frame, parent, measured);
    if (fixedHeight && para.getHeight() > box.h + 0.5) this.warnings.push(`text "${layer.id}" overflows its box`);

    this.drawScaled(canvas, (c) => c.drawParagraph(para, box.x, box.y));
    para.delete();
    this.fittedSizes.set(layer.id, size);
    return box;
  }

  private paragraph(layer: TextLayer, size: number, width: number | undefined): Paragraph {
    const { ck } = this;
    const { style } = layer;
    const align = { start: ck.TextAlign.Start, center: ck.TextAlign.Center, end: ck.TextAlign.End, justify: ck.TextAlign.Justify };
    if (style.fill && typeof style.fill !== "string") {
      this.warnings.push(`text "${layer.id}": gradient fills are not rendered yet; using the first stop`);
    }
    const fill = style.fill === undefined ? "#000000" : typeof style.fill === "string" ? style.fill : style.fill.stops[0]!.color;
    const paraStyle = new ck.ParagraphStyle({
      textAlign: align[style.align ?? "start"],
      textDirection: layer.direction === "rtl" ? ck.TextDirection.RTL : ck.TextDirection.LTR,
      textStyle: {
        color: this.color(fill),
        fontFamilies: [style.font],
        fontSize: size,
        fontStyle: { weight: { value: style.weight ?? 400 } as never },
        letterSpacing: ((style.tracking ?? 0) / 1000) * size,
        ...(style.leading ? { heightMultiplier: style.leading / size, halfLeading: true } : {}),
      },
    });
    const builder = ck.ParagraphBuilder.MakeFromFontProvider(paraStyle, this.res.fonts);
    builder.addText(layer.content);
    const para = builder.build();
    builder.delete();
    para.layout(width ?? 1e6);
    return para;
  }

  private drawShape(c: Canvas, shape: Shape, box: Box, paint: Paint): void {
    const rect = this.ck.XYWHRect(box.x, box.y, box.w, box.h);
    if (shape.kind === "rect") {
      if (shape.radius) c.drawRRect(this.ck.RRectXY(rect, shape.radius, shape.radius), paint);
      else c.drawRect(rect, paint);
    } else if (shape.kind === "ellipse") {
      c.drawOval(rect, paint);
    } else {
      const path = this.ck.Path.MakeFromSVGString(shape.d);
      if (!path) throw new Error(`Invalid SVG path "${shape.d}"`);
      path.offset(box.x, box.y);
      c.drawPath(path, paint);
      path.delete();
    }
    paint.delete();
  }

  /** Builds a coverage image whose alpha is the mask. */
  private maskImage(mask: Mask, box: Box, parent: Box): Image {
    const { ck } = this;
    const s = this.surface();
    const canvas = s.getCanvas();
    if (mask.kind === "vector") {
      this.drawScaled(canvas, (c) => this.drawShape(c, mask.shape, box, this.paint("#ffffff", box)));
    } else if (mask.kind === "raster") {
      const image = this.res.images.get(mask.asset)!;
      const p = new ck.Paint();
      p.setColorFilter(ck.ColorFilter.MakeLuma());
      if (mask.invert) {
        this.drawScaled(canvas, (c) => c.drawRect(ck.XYWHRect(box.x, box.y, box.w, box.h), this.paint("#ffffff", box)));
        p.setBlendMode(ck.BlendMode.DstOut);
      }
      const src = ck.XYWHRect(0, 0, image.width(), image.height());
      this.drawScaled(canvas, (c) => c.drawImageRect(image, src, ck.XYWHRect(box.x, box.y, box.w, box.h), p));
      p.delete();
    } else {
      const source = this.byId.get(mask.layer);
      if (!source) throw new Error(`Mask refers to missing layer "${mask.layer}"`);
      const image = this.renderLayer(source, parent, false);
      const p = new ck.Paint();
      p.setColorFilter(ck.ColorFilter.MakeLuma());
      canvas.drawImage(image, 0, 0, p);
      p.delete();
      image.delete();
    }
    let image = s.makeImageSnapshot();
    s.delete();
    if (mask.kind !== "luminance-of" && mask.feather) image = this.blur(image, mask.feather);
    return image;
  }

  /** Adjustment layers recolour everything below them in scope, weighted by opacity, mask and clip base. */
  private adjust(layer: Extract<Layer, { type: "adjustment" }>, parent: Box, target: Surface, clipBase: Image | null): void {
    const pixels = this.readPixels(target);
    const adjusted = pixels.slice();
    applyAdjustment(adjusted, layer.adjustment);

    const opacity = layer.opacity ?? 1;
    const mask = layer.mask ? this.readImageAlpha(this.maskImage(layer.mask, resolveFrame(layer.frame, parent), parent)) : null;
    const base = clipBase ? this.readImageAlpha(clipBase, false) : null;
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
      let t = opacity;
      if (mask) t *= mask[p]! / 255;
      if (base) t *= base[p]! / 255;
      if (t === 0) continue;
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(pixels[i + c]! + (adjusted[i + c]! - pixels[i + c]!) * t);
    }

    const image = this.ck.MakeImage(this.info(this.ck.AlphaType.Unpremul), pixels, this.width * 4)!;
    const canvas = target.getCanvas();
    canvas.clear(this.ck.TRANSPARENT);
    canvas.drawImage(image, 0, 0);
    image.delete();
  }

  private blur(image: Image, radius: number): Image {
    const s = this.surface();
    const p = new this.ck.Paint();
    const sigma = radius * this.scale;
    p.setImageFilter(this.ck.ImageFilter.MakeBlur(sigma, sigma, this.ck.TileMode.Decal, null));
    // Blur through a save layer: drawImage with an image-filter paint double-premultiplies
    // in CanvasKit 0.40, which darkens soft edges into a grey halo.
    const canvas = s.getCanvas();
    canvas.saveLayer(p);
    canvas.drawImage(image, 0, 0);
    canvas.restore();
    p.delete();
    image.delete();
    const out = s.makeImageSnapshot();
    s.delete();
    return out;
  }

  private paint(paint: GessoPaint, box: Box): Paint {
    const { ck } = this;
    const p = new ck.Paint();
    p.setAntiAlias(true);
    if (typeof paint === "string") {
      p.setColor(this.color(paint));
      return p;
    }
    const colors = paint.stops.map((s) => this.color(s.color));
    const positions = paint.stops.map((s) => s.offset);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    if (paint.kind === "linear-gradient") {
      // Photoshop angles: 0° runs left to right, 90° bottom to top.
      const a = (paint.angle * Math.PI) / 180;
      const dx = Math.cos(a);
      const dy = -Math.sin(a);
      const half = (Math.abs(box.w * dx) + Math.abs(box.h * dy)) / 2;
      p.setShader(
        ck.Shader.MakeLinearGradient([cx - dx * half, cy - dy * half], [cx + dx * half, cy + dy * half], colors, positions, ck.TileMode.Clamp),
      );
    } else {
      p.setShader(ck.Shader.MakeRadialGradient([cx, cy], Math.max(box.w, box.h) / 2, colors, positions, ck.TileMode.Clamp));
    }
    return p;
  }

  private color(hex: string) {
    const n = hex.slice(1);
    const v = (i: number) => parseInt(n.slice(i, i + 2), 16);
    return this.ck.Color(v(0), v(2), v(4), n.length === 8 ? v(6) / 255 : 1);
  }

  private drawImage(
    target: Surface,
    image: Image,
    blend: BlendMode | undefined,
    opacity = 1,
    mode?: keyof CanvasKit["BlendMode"],
  ): void {
    const p = new this.ck.Paint();
    p.setBlendMode(this.ck.BlendMode[mode ?? BLEND[blend ?? "normal"]] as never);
    p.setAlphaf(opacity);
    target.getCanvas().drawImage(image, 0, 0, p);
    p.delete();
  }

  private drawScaled(canvas: Canvas, draw: (c: Canvas) => void): void {
    canvas.save();
    canvas.scale(this.scale, this.scale);
    draw(canvas);
    canvas.restore();
  }

  private surface(): Surface {
    const s = this.ck.MakeSurface(this.width, this.height);
    if (!s) throw new Error("Could not allocate a render surface");
    s.getCanvas().clear(this.ck.TRANSPARENT);
    return s;
  }

  private info(alphaType: CanvasKit["AlphaType"]["Unpremul"], width = this.width, height = this.height) {
    const { ck } = this;
    return { width, height, colorType: ck.ColorType.RGBA_8888, alphaType, colorSpace: ck.ColorSpace.SRGB };
  }

  private readPixels(s: Surface): Uint8Array {
    const image = s.makeImageSnapshot();
    const pixels = image.readPixels(0, 0, this.info(this.ck.AlphaType.Unpremul)) as Uint8Array;
    image.delete();
    return pixels;
  }

  private readImageAlpha(image: Image, dispose = true): Uint8Array {
    const pixels = image.readPixels(0, 0, this.info(this.ck.AlphaType.Unpremul)) as Uint8Array;
    if (dispose) image.delete();
    const alpha = new Uint8Array(this.width * this.height);
    for (let i = 0; i < alpha.length; i++) alpha[i] = pixels[i * 4 + 3]!;
    return alpha;
  }
}

function quadBounds(quad: Array<[number, number]>): Box {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
