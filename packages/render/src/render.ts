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
import { extractFace } from "./fonts.js";
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
  /**
   * Content plus smart filters, without mask, opacity or blend, cropped to the pixels that
   * aren't transparent; pixelBox says where they sit in the artboard. Absent for groups,
   * adjustments and empty layers.
   */
  pixels?: Uint8Array;
  pixelBox?: { x: number; y: number; w: number; h: number };
  /** Mask coverage, one byte per pixel. */
  mask?: Uint8Array;
  /** Font size after shrink-to-fit, for text layers. */
  fontSize?: number;
  /** Corner pin in artboard pixels (TL, TR, BR, BL), for smart layers. Includes any rotation. */
  quad?: Array<[number, number]>;
  /**
   * For SVG path shapes: each subpath as cubic segments in artboard pixels, before rotation:
   * [x0, y0, c1x, c1y, c2x, c2y, x1, y1, …], with `closed` per subpath.
   */
  paths?: Array<{ points: number[]; closed: boolean }>;
  /** Rotation and flips from this layer and its groups, in artboard pixels. Absent when there are none. */
  matrix?: Affine;
};

/** A 2D affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

/** The layer's rotation and flip around the centre of its box, or undefined when it has neither. */
export function layerTransform(layer: { rotation?: number; flip?: "horizontal" | "vertical" | "both" }, box: Box): Affine | undefined {
  if (!layer.rotation && !layer.flip) return undefined;
  const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
  const sx = layer.flip === "horizontal" || layer.flip === "both" ? -1 : 1;
  const sy = layer.flip === "vertical" || layer.flip === "both" ? -1 : 1;
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  const [a, b, c, d] = [cos * sx, sin * sx, -sin * sy, cos * sy];
  const [cx, cy] = [box.x + box.w / 2, box.y + box.h / 2];
  return [a, b, c, d, cx - (a * cx + c * cy), cy - (b * cx + d * cy)];
}

/** m after n. Either may be undefined, meaning no transform. */
export function compose(m: Affine | undefined, n: Affine | undefined): Affine | undefined {
  if (!m || !n) return m ?? n;
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function transformPoint(m: Affine | undefined, x: number, y: number): [number, number] {
  return m ? [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]] : [x, y];
}
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
    fonts.registerFont(extractFace(await loader(asset), asset.face ?? 0), asset.family);
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
    target.dispose();
    return { artboard: artboard.id, width: this.width, height: this.height, pixels, warnings: this.warnings };
  }

  parts(artboard: Artboard): LayerParts {
    this.width = Math.max(1, Math.round(artboard.frame.w));
    this.height = Math.max(1, Math.round(artboard.frame.h));
    this.index(artboard.layers);
    const parts = new Map<string, LayerPart>();
    const visit = (layers: Layer[], parent: Box, inherited: Affine | undefined) => {
      for (const layer of layers) {
        const part: LayerPart = { id: layer.id, box: resolveFrame(layer.frame, parent) };
        if (layer.type !== "group" && layer.type !== "adjustment") {
          const drawn = layer.filters?.length ? this.partFiltered(layer, parent, inherited) : this.partBounded(layer, parent, inherited);
          part.box = drawn.box;
          if (drawn.cropped) {
            part.pixels = drawn.cropped.pixels;
            part.pixelBox = drawn.cropped.box;
          }
          const fitted = this.fittedSizes.get(layer.id);
          if (fitted !== undefined) part.fontSize = fitted;
          if (layer.type === "smart") {
            const b = part.box;
            part.quad = layer.quad
              ? layer.quad.map(([x, y]) => [parent.x + x, parent.y + y] as [number, number])
              : [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]];
          }
        }
        if (layer.type === "shape" && layer.shape.kind === "path") part.paths = this.cubicPaths(layer.shape.d, part.box);
        part.matrix = compose(inherited, layerTransform(layer, part.box));
        if (part.quad && part.matrix) part.quad = part.quad.map(([x, y]) => transformPoint(part.matrix, x, y));
        if (layer.mask) part.mask = this.readImageAlpha(this.maskImage(layer.mask, part.box, parent));
        parts.set(layer.id, part);
        if (layer.type === "group") visit(layer.children, part.box, part.matrix);
      }
    };
    visit(artboard.layers, { x: 0, y: 0, w: artboard.frame.w, h: artboard.frame.h }, undefined);
    return { width: this.width, height: this.height, parts, warnings: this.warnings };
  }

  /** An SVG path as cubic Bézier subpaths placed in the box, for vector output. Arcs come through as conics and are converted. */
  private cubicPaths(d: string, box: Box): Array<{ points: number[]; closed: boolean }> {
    const path = this.ck.Path.MakeFromSVGString(d);
    if (!path) return [];
    path.offset(box.x, box.y);
    const cmds = path.toCmds();
    path.delete();
    const out: Array<{ points: number[]; closed: boolean }> = [];
    let current: { points: number[]; closed: boolean } | undefined;
    let [x, y] = [0, 0];
    const cubic = (c1x: number, c1y: number, c2x: number, c2y: number, ex: number, ey: number) => {
      current!.points.push(c1x, c1y, c2x, c2y, ex, ey);
      [x, y] = [ex, ey];
    };
    for (let i = 0; i < cmds.length; ) {
      const verb = cmds[i++]!;
      const n = (k: number) => cmds[i + k]!;
      if (verb === this.ck.MOVE_VERB) {
        current = { points: [n(0), n(1)], closed: false };
        out.push(current);
        [x, y] = [n(0), n(1)];
        i += 2;
      } else if (verb === this.ck.LINE_VERB) {
        cubic(x, y, n(0), n(1), n(0), n(1));
        i += 2;
      } else if (verb === this.ck.QUAD_VERB || verb === this.ck.CONIC_VERB) {
        // A quadratic is a conic with weight 1; k = 4w / (3(1 + w)) gives the cubic handles.
        const w = verb === this.ck.CONIC_VERB ? n(4) : 1;
        const k = (4 * w) / (3 * (1 + w));
        cubic(x + (n(0) - x) * k, y + (n(1) - y) * k, n(2) + (n(0) - n(2)) * k, n(3) + (n(1) - n(3)) * k, n(2), n(3));
        i += verb === this.ck.CONIC_VERB ? 5 : 4;
      } else if (verb === this.ck.CUBIC_VERB) {
        cubic(n(0), n(1), n(2), n(3), n(4), n(5));
        i += 6;
      } else if (verb === this.ck.CLOSE_VERB && current) {
        current.closed = true;
      }
    }
    return out.filter((p) => p.points.length > 2);
  }

  /** A layer's pixels, drawn on a surface only as big as what it draws. */
  private partBounded(layer: Layer, parent: Box, inherited: Affine | undefined) {
    const recorder = new this.ck.PictureRecorder();
    const limit = 1e6;
    const canvas = recorder.beginRecording(this.ck.LTRBRect(-limit, -limit, limit, limit), true);
    if (inherited) canvas.concat(this.deviceMatrix(inherited));
    const box = this.drawContent(layer, parent, undefined, canvas);
    const picture = recorder.finishRecordingAsPicture();
    recorder.delete();
    const [l, t, r, b] = picture.cullRect();
    const x = Math.max(0, Math.floor(l!));
    const y = Math.max(0, Math.floor(t!));
    const w = Math.min(this.width, Math.ceil(r!)) - x;
    const h = Math.min(this.height, Math.ceil(b!)) - y;
    let cropped: ReturnType<typeof cropToContent>;
    if (w > 0 && h > 0) {
      const s = this.ck.MakeSurface(w, h)!;
      const c = s.getCanvas();
      c.clear(this.ck.TRANSPARENT);
      c.translate(-x, -y);
      c.drawPicture(picture);
      const pixels = s.makeImageSnapshot();
      s.dispose();
      const found = cropToContent(pixels.readPixels(0, 0, this.info(this.ck.AlphaType.Unpremul, w, h)) as Uint8Array, w, h);
      pixels.delete();
      if (found) cropped = { pixels: found.pixels, box: { ...found.box, x: found.box.x + x, y: found.box.y + y } };
    }
    picture.delete();
    return { box, cropped };
  }

  /** A layer with smart filters, which can spread past its bounds, drawn on a full artboard. */
  private partFiltered(layer: Layer, parent: Box, inherited: Affine | undefined) {
    const s = this.surface();
    if (inherited) s.getCanvas().concat(this.deviceMatrix(inherited));
    const box = this.drawContent(layer, parent, s);
    let image = s.makeImageSnapshot();
    s.dispose();
    for (const filter of layer.filters ?? []) {
      if (filter.kind === "gaussian-blur") image = this.blur(image, filter.radius);
    }
    // Crop right away: keeping a full-artboard copy per layer runs out of memory on large posters.
    const cropped = cropToContent(image.readPixels(0, 0, this.info(this.ck.AlphaType.Unpremul)) as Uint8Array, this.width, this.height);
    image.delete();
    return { box, cropped };
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

      if (clipped.length === 0 && this.drawDirect(base, parent, target)) continue;

      const content = this.renderLayer(base, parent);
      // Shadows and glows follow the styled shape, strokes included, as in Photoshop.
      const styled = base.effects?.length ? this.withEffectsAbove(content, base) : content;
      if (base.effects?.length) this.drawEffectsBelow(target, styled, base);
      if (clipped.length === 0) {
        this.drawImage(target, styled, base.blend, base.opacity);
        if (styled !== content) styled.delete();
        content.delete();
        continue;
      }

      // Clipped layers clip to the base's own pixels, not to its effects.
      const group = this.surface();
      group.getCanvas().drawImage(styled, 0, 0);
      if (styled !== content) styled.delete();
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
        s.dispose();
        this.drawImage(group, clippedImage, layer.blend, layer.opacity);
        clippedImage.delete();
      }
      const groupImage = group.makeImageSnapshot();
      group.dispose();
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
      !group.filters?.length &&
      !group.effects?.length &&
      !layerTransform(group, { x: 0, y: 0, w: 0, h: 0 })
    );
  }

  /**
   * Draws a plain layer (no mask, filters, transform or clipped layers) straight onto target,
   * blending only within its own bounds. Skipping the artboard-sized intermediate makes large
   * documents many times faster. Returns false when the layer needs the full path.
   */
  private drawDirect(layer: Layer, parent: Box, target: Surface): boolean {
    if (layer.type === "group" || layer.type === "adjustment" || layer.mask || layer.filters?.length || layer.effects?.length || layer.rotation || layer.flip) {
      return false;
    }
    const recorder = new this.ck.PictureRecorder();
    const limit = 1e6;
    this.drawUntransformed(layer, parent, target, recorder.beginRecording(this.ck.LTRBRect(-limit, -limit, limit, limit), true));
    const picture = recorder.finishRecordingAsPicture();
    recorder.delete();
    const canvas = target.getCanvas();
    const blend = layer.blend ?? "normal";
    const opacity = layer.opacity ?? 1;
    if (blend === "normal" && opacity === 1) {
      canvas.drawPicture(picture);
    } else {
      const p = new this.ck.Paint();
      p.setBlendMode(this.ck.BlendMode[BLEND[blend]] as never);
      p.setAlphaf(opacity);
      canvas.saveLayer(p, picture.cullRect());
      canvas.drawPicture(picture);
      canvas.restore();
      p.delete();
    }
    picture.delete();
    return true;
  }

  /** Drop shadows, outer glows and outside strokes, drawn onto target beneath the layer. */
  private drawEffectsBelow(target: Surface, content: Image, layer: Layer): void {
    const { ck } = this;
    const k = this.scale;
    const opacity = layer.opacity ?? 1;
    for (const effect of layer.effects ?? []) {
      if (effect.kind !== "drop-shadow" && effect.kind !== "outer-glow") continue;
      const size = (effect.size ?? (effect.kind === "drop-shadow" ? 10 : 20)) * k;
      const spread = effect.spread ?? 0;
      const color = this.color(effect.color ?? (effect.kind === "drop-shadow" ? "#000000" : "#FFFFFF"));
      const angle = (((effect.kind === "drop-shadow" ? effect.angle : undefined) ?? 120) * Math.PI) / 180;
      const distance = (effect.kind === "drop-shadow" ? (effect.distance ?? 10) : 0) * k;
      // Spread grows the shape solidly before the remaining size blurs, like Photoshop's spread/choke.
      const grow = spread > 0 ? ck.ImageFilter.MakeDilate(size * spread, size * spread, null) : null;
      const sigma = (size * (1 - spread)) / 2;
      const filter = ck.ImageFilter.MakeDropShadowOnly(-Math.cos(angle) * distance, Math.sin(angle) * distance, sigma, sigma, color, grow);
      const p = new ck.Paint();
      p.setImageFilter(filter);
      p.setAlphaf((effect.opacity ?? (effect.kind === "drop-shadow" ? 0.35 : 0.75)) * opacity);
      p.setBlendMode(effect.kind === "drop-shadow" ? ck.BlendMode.Multiply : ck.BlendMode.Screen);
      target.getCanvas().drawImage(content, 0, 0, p);
      p.delete();
      filter.delete();
    }
  }

  /** The layer with its colour overlays and strokes applied, as a new image. */
  private withEffectsAbove(content: Image, layer: Layer): Image {
    const { ck } = this;
    const k = this.scale;
    const s = this.surface();
    const canvas = s.getCanvas();
    // Outside strokes sit behind the content; the rest go on top.
    const strokes = (layer.effects ?? []).filter((e) => e.kind === "stroke");
    for (const stroke of strokes.filter((e) => (e.position ?? "outside") === "outside")) this.drawStroke(canvas, content, stroke, k);
    canvas.drawImage(content, 0, 0);
    for (const effect of layer.effects ?? []) {
      if (effect.kind !== "color-overlay") continue;
      const p = new ck.Paint();
      p.setColorFilter(ck.ColorFilter.MakeBlend(this.color(effect.color), ck.BlendMode.SrcIn));
      p.setAlphaf(effect.opacity ?? 1);
      canvas.drawImage(content, 0, 0, p);
      p.delete();
    }
    for (const stroke of strokes.filter((e) => (e.position ?? "outside") !== "outside")) this.drawStroke(canvas, content, stroke, k);
    const image = s.makeImageSnapshot();
    s.dispose();
    return image;
  }

  /** A stroke around the content's alpha: grown outward, shrunk inward, or both for centred. */
  private drawStroke(canvas: Canvas, content: Image, stroke: Extract<NonNullable<Layer["effects"]>[number], { kind: "stroke" }>, k: number): void {
    const { ck } = this;
    const position = stroke.position ?? "outside";
    const w = stroke.width * k;
    const [outer, inner] = position === "outside" ? [w, 0] : position === "inside" ? [0, w] : [w / 2, w / 2];
    const ring = this.surface();
    const c = ring.getCanvas();
    const tint = ck.ColorFilter.MakeBlend(this.color(stroke.color), ck.BlendMode.SrcIn);
    const grow = new ck.Paint();
    grow.setImageFilter(outer > 0 ? ck.ImageFilter.MakeDilate(outer, outer, null) : null);
    grow.setColorFilter(tint);
    c.drawImage(content, 0, 0, grow);
    const cut = new ck.Paint();
    cut.setImageFilter(inner > 0 ? ck.ImageFilter.MakeErode(inner, inner, null) : null);
    cut.setBlendMode(ck.BlendMode.DstOut);
    c.drawImage(content, 0, 0, cut);
    const image = ring.makeImageSnapshot();
    ring.dispose();
    const p = new ck.Paint();
    p.setAlphaf(stroke.opacity ?? 1);
    canvas.drawImage(image, 0, 0, p);
    [grow, cut, p].forEach((x) => x.delete());
    image.delete();
  }

  /** Renders one layer's content, smart filters and mask onto a transparent artboard-sized image. */
  private renderLayer(layer: Layer, parent: Box, withMask = true): Image {
    const s = this.surface();
    const box = this.drawContent(layer, parent, s);
    let image = s.makeImageSnapshot();
    s.dispose();

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
      out.dispose();
    }
    return image;
  }

  /** Draws the layer's content, rotated and flipped as the layer says. */
  /** `s` is needed only for groups, which composite their children onto it. */
  private drawContent(layer: Layer, parent: Box, s: Surface | undefined, canvas: Canvas = s!.getCanvas()): Box {
    if (!layer.rotation && !layer.flip) return this.drawUntransformed(layer, parent, s, canvas);
    const p = new this.ck.Paint();
    p.setAntiAlias(true);
    let box: Box;
    if (layer.type === "group") {
      // Children composite on their own, so adjustments inside see the group unrotated.
      const flat = this.surface();
      box = this.drawUntransformed(layer, parent, flat);
      const image = flat.makeImageSnapshot();
      flat.dispose();
      canvas.save();
      canvas.concat(this.deviceMatrix(layerTransform(layer, box)!));
      canvas.drawImageOptions(image, 0, 0, this.ck.FilterMode.Linear, this.ck.MipmapMode.None, p);
      canvas.restore();
      image.delete();
    } else {
      // Recorded as vectors first, so content past the artboard edge can rotate into view.
      const recorder = new this.ck.PictureRecorder();
      const limit = 1e6;
      box = this.drawUntransformed(layer, parent, s, recorder.beginRecording(this.ck.LTRBRect(-limit, -limit, limit, limit)));
      const picture = recorder.finishRecordingAsPicture();
      recorder.delete();
      canvas.save();
      canvas.concat(this.deviceMatrix(layerTransform(layer, box)!));
      canvas.drawPicture(picture);
      canvas.restore();
      picture.delete();
    }
    p.delete();
    return box;
  }

  /** An artboard-pixel transform as a CanvasKit matrix in device pixels. */
  private deviceMatrix([a, b, c, d, e, f]: Affine): number[] {
    return [a, c, e * this.scale, b, d, f * this.scale, 0, 0, 1];
  }

  private drawUntransformed(layer: Layer, parent: Box, s: Surface | undefined, canvas: Canvas = s!.getCanvas()): Box {
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
        if (!s) throw new Error(`group "${layer.id}" needs a surface to composite onto`);
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
    target.dispose();
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
    s.dispose();
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
    s.dispose();
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

/** The smallest box holding every pixel that isn't fully transparent, or undefined if there are none. */
function cropToContent(pixels: Uint8Array, width: number, height: number) {
  let [minX, minY, maxX, maxY] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (pixels[row + x * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return undefined;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(pixels.subarray(((minY + y) * width + minX) * 4, ((minY + y) * width + minX + w) * 4), y * w * 4);
  return { pixels: out, box: { x: minX, y: minY, w, h } };
}
