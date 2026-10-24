import { createHash } from "node:crypto";
import type {
  Artboard,
  Asset,
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
import { paintColor } from "@gesso/core";
import { extractFace } from "./fonts.js";
import { meshVertices } from "./mesh.js";
import { directionField, samplePath, shaderEffect, shearRows, type ShaderName } from "./shaders.js";
import type { CanvasKit, Canvas, Font, Image, Paint, Paragraph, Shader, Surface, Typeface, TypefaceFontProvider } from "canvaskit-wasm";
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
export type Rendered = {
  artboard: string;
  width: number;
  height: number;
  pixels: Uint8Array;
  warnings: string[];
  /** Background blurs as drawn, by layer id: unpremultiplied RGBA within a box in output pixels. PSD export bakes these. */
  backdrops?: Map<string, Backdrop>;
};
export type Backdrop = { pixels: Uint8Array; x: number; y: number; w: number; h: number };
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
  /** Laid-out lines of a text layer: UTF-16 ranges of content, with x and baseline in artboard units. */
  lines?: TextLine[];
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
export type TextLine = { start: number; end: number; left: number; baseline: number };
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
    const compositor = new Compositor(ck, resources, options.scale ?? 1, doc.symbols ?? {});
    try {
      const out = compositor.render(artboard);
      out.warnings.unshift(...resources.warnings);
      return out;
    } finally {
      compositor.release();
    }
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
    const compositor = new Compositor(ck, resources, 1, doc.symbols ?? {});
    try {
      const out = compositor.parts(artboard);
      out.warnings.unshift(...resources.warnings);
      return out;
    } finally {
      compositor.release();
    }
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
  /** Font file bytes by family, for text that's laid out glyph by glyph (text on a path). */
  fontData: Map<string, Uint8Array>;
  warnings: string[];
  dispose(): void;
};

// Decoded images, kept between renders by content hash: decoding a large photo costs far
// more than reading it, and agents render the same document over and over.
type Cached = { image: Image; bytes: number; users: number; used: number };
const imageCache = new Map<string, Cached>();
const CACHE_BUDGET = 512 * 1024 * 1024;

function evict(): void {
  let total = [...imageCache.values()].reduce((sum, c) => sum + c.bytes, 0);
  const idle = [...imageCache.entries()].filter(([, c]) => c.users === 0).sort((a, b) => a[1].used - b[1].used);
  for (const [key, c] of idle) {
    if (total <= CACHE_BUDGET) break;
    c.image.delete();
    imageCache.delete(key);
    total -= c.bytes;
  }
}

/** Loads an asset's bytes, with an error that says which asset and how to fix it. */
async function loadAsset(loader: AssetLoader, id: string, asset: Asset): Promise<Uint8Array> {
  try {
    return await loader(asset);
  } catch (err) {
    const reason = (err as NodeJS.ErrnoException).code === "ENOENT" ? "the file isn't there" : (err as Error).message;
    throw new Error(
      `Asset "${id}" (${asset.uri}) couldn't be loaded: ${reason}. Point it at the right file with asset_import (same id, replace: true), or change the layers that use it.`,
    );
  }
}

/** Decodes an image asset, or reuses the decoded copy from an earlier render. */
async function decodeImage(ck: CanvasKit, id: string, asset: Asset, bytes: Uint8Array): Promise<Cached> {
  const key = createHash("sha1").update(bytes).digest("hex");
  let cached = imageCache.get(key);
  if (!cached) {
    const { data, info } = await sharp(bytes)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
      .catch(() => {
        throw new Error(`Asset "${id}" (${asset.uri}) isn't an image Gesso can read`);
      });
    const image = ck.MakeImage(
      { width: info.width, height: info.height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB },
      data,
      info.width * 4,
    );
    if (!image) throw new Error(`Could not decode asset "${id}"`);
    cached = { image, bytes: info.width * info.height * 4, users: 0, used: 0 };
    imageCache.set(key, cached);
  }
  cached.used = Date.now();
  return cached;
}

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
  const held: Cached[] = [];
  const warnings: string[] = [];
  const release = () => held.forEach((c) => c.users--);
  try {
    for (const id of used) {
      const asset = doc.assets[id];
      if (!asset) throw new Error(`Missing asset "${id}": add it with asset_import, or change the layers that use it`);
      const cached = await decodeImage(ck, id, asset, await loadAsset(loader, id, asset));
      cached.users++;
      held.push(cached);
      images.set(id, cached.image);
    }
  } catch (err) {
    release();
    throw err;
  }

  const fonts = ck.TypefaceFontProvider.Make();
  const families = new Set<string>();
  const fontData = new Map<string, Uint8Array>();
  for (const [id, asset] of Object.entries(doc.assets)) {
    if (asset.kind !== "font") continue;
    if (!asset.family) throw new Error(`Font asset ${asset.uri} needs a "family"`);
    // A missing font shouldn't stop the render: its text falls back and the warning says why.
    try {
      const face = extractFace(await loadAsset(loader, id, asset), asset.face ?? 0);
      fonts.registerFont(face, asset.family);
      families.add(asset.family);
      if (!fontData.has(asset.family)) fontData.set(asset.family, face);
    } catch (err) {
      warnings.push((err as Error).message);
    }
  }

  return {
    images,
    fonts,
    families,
    fontData,
    warnings,
    dispose() {
      release();
      evict();
      fonts.delete();
    },
  };
}

class Compositor {
  private width = 0;
  private height = 0;
  warnings: string[] = [];
  backdrops = new Map<string, Backdrop>();
  private byId = new Map<string, Layer>();
  private typefaces = new Map<string, Typeface | null>();

  /** Frees the fonts this compositor made. */
  release(): void {
    for (const d of this.disposables.splice(0)) d.delete();
    this.typefaces.clear();
  }
  /** CanvasKit objects to free when the render finishes. */
  private disposables: Array<{ delete(): void }> = [];
  /** Device-pixel bounds of the last layer renderLayer drew, when known (not for groups). */
  private lastBounds: [number, number, number, number] | undefined;
  /** While compositing one layer: the area it and its effects can touch. Draws outside are skipped. */
  private reach: [number, number, number, number] | undefined;
  private fittedSizes = new Map<string, number>();
  private textLines = new Map<string, TextLine[]>();

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
    return { artboard: artboard.id, width: this.width, height: this.height, pixels, warnings: this.warnings, backdrops: this.backdrops };
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
          const drawn = this.partBounded(layer, parent, inherited);
          part.box = drawn.box;
          if (drawn.cropped) {
            part.pixels = drawn.cropped.pixels;
            part.pixelBox = drawn.cropped.box;
          }
          const fitted = this.fittedSizes.get(layer.id);
          if (fitted !== undefined) part.fontSize = fitted;
          const lines = this.textLines.get(layer.id);
          if (lines) part.lines = lines;
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

  /** A layer's pixels and where they sit, cropped to what isn't transparent. */
  private partBounded(layer: Layer, parent: Box, inherited: Affine | undefined) {
    const { box, image, x, y } = this.renderBounded(layer, parent, inherited);
    let cropped: ReturnType<typeof cropToContent>;
    if (image) {
      const [w, h] = [image.width(), image.height()];
      const found = cropToContent(image.readPixels(0, 0, this.info(this.ck.AlphaType.Unpremul, w, h)) as Uint8Array, w, h);
      image.delete();
      if (found) cropped = { pixels: found.pixels, box: { ...found.box, x: found.box.x + x, y: found.box.y + y } };
    }
    return { box, cropped };
  }

  /**
   * A non-group layer's content, transforms and smart filters, rendered on a surface only as
   * big as they reach (blur included), placed at (x, y) in device pixels. Allocating and
   * blurring artboard-sized surfaces per layer is what made large posters slow.
   */
  private renderBounded(layer: Layer, parent: Box, inherited?: Affine): { box: Box; image?: Image; x: number; y: number } {
    const recorder = new this.ck.PictureRecorder();
    const limit = 1e6;
    const canvas = recorder.beginRecording(this.ck.LTRBRect(-limit, -limit, limit, limit), true);
    if (inherited) canvas.concat(this.deviceMatrix(inherited));
    const box = this.drawContent(layer, parent, undefined, canvas);
    const picture = recorder.finishRecordingAsPicture();
    recorder.delete();
    // A Gaussian blur reaches about three sigmas.
    const margin = (layer.filters ?? []).reduce((m, f) => m + Math.ceil(filterReach(f, box) * this.scale), 0);
    const [l, t, r, b] = picture.cullRect();
    const x = Math.max(0, Math.floor(l! - margin));
    const y = Math.max(0, Math.floor(t! - margin));
    const w = Math.min(this.width, Math.ceil(r! + margin)) - x;
    const h = Math.min(this.height, Math.ceil(b! + margin)) - y;
    if (w <= 0 || h <= 0) {
      picture.delete();
      return { box, x, y };
    }
    const s = this.ck.MakeSurface(w, h);
    if (!s) throw new Error("Could not allocate a render surface");
    const c = s.getCanvas();
    c.clear(this.ck.TRANSPARENT);
    c.translate(-x, -y);
    c.drawPicture(picture);
    picture.delete();
    let image = s.makeImageSnapshot();
    s.dispose();
    for (const filter of layer.filters ?? []) image = this.filter(image, filter, box, x, y);
    return { box, image, x, y };
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
      this.reach = this.reachOf(base, this.lastBounds);
      try {
        const fill = base.fillOpacity ?? 1;
        const styled = base.effects?.length || fill < 1 ? this.withEffectsAbove(content, base, fill) : content;
        if (base.effects?.length) {
          // Shadows and glows follow the styled shape, strokes included, and ignore fill opacity, as in Photoshop.
          const shape = fill < 1 ? this.withEffectsAbove(content, base, 1) : styled;
          this.drawEffectsBelow(target, shape, base);
          if (shape !== styled) shape.delete();
          for (const effect of base.effects) if (effect.kind === "background-blur") this.drawBackgroundBlur(target, base, parent, effect.radius);
        }
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
      } finally {
        this.reach = undefined;
      }
    }
  }

  /** The layer's bounds grown by how far its effects spread, clamped to the artboard. */
  private reachOf(layer: Layer, bounds: [number, number, number, number] | undefined): [number, number, number, number] | undefined {
    if (!bounds) return undefined;
    const k = this.scale;
    let grow = 0;
    for (const e of layer.effects ?? []) {
      if (e.kind === "stroke") grow = Math.max(grow, e.width * k);
      if (e.kind === "drop-shadow") grow = Math.max(grow, ((e.distance ?? 10) + (e.size ?? 10) * 1.5 + 2) * k);
      if (e.kind === "outer-glow") grow = Math.max(grow, ((e.size ?? 20) * 1.5 + 2) * k);
    }
    const [l, t, r, b] = bounds;
    return [Math.max(0, l - grow), Math.max(0, t - grow), Math.min(this.width, r + grow), Math.min(this.height, b + grow)];
  }

  /** Runs draw with the canvas clipped to the current layer's reach, if there is one. */
  private inReach(canvas: Canvas, draw: () => void): void {
    if (!this.reach) return draw();
    canvas.save();
    canvas.clipRect(this.ck.LTRBRect(...this.reach), this.ck.ClipOp.Intersect, false);
    draw();
    canvas.restore();
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
    if (layer.type === "group" || layer.type === "adjustment" || layer.mask || layer.effects?.length) return false;
    const canvas = target.getCanvas();
    const blend = layer.blend ?? "normal";
    const opacity = (layer.opacity ?? 1) * (layer.fillOpacity ?? 1);
    if (layer.filters?.length) {
      // Filtered layers render bounded, then blend in as an image.
      const { image, x, y } = this.renderBounded(layer, parent);
      if (image) {
        const p = new this.ck.Paint();
        p.setBlendMode(this.ck.BlendMode[BLEND[blend]] as never);
        p.setAlphaf(opacity);
        canvas.drawImage(image, x, y, p);
        p.delete();
        image.delete();
      }
      return true;
    }
    const recorder = new this.ck.PictureRecorder();
    const limit = 1e6;
    this.drawContent(layer, parent, undefined, recorder.beginRecording(this.ck.LTRBRect(-limit, -limit, limit, limit), true));
    const picture = recorder.finishRecordingAsPicture();
    recorder.delete();
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
      const canvas = target.getCanvas();
      this.inReach(canvas, () => canvas.drawImage(content, 0, 0, p));
      p.delete();
      filter.delete();
    }
  }

  /** The layer with its colour overlays and strokes applied, as a new image. */
  private withEffectsAbove(content: Image, layer: Layer, fill = 1): Image {
    const { ck } = this;
    const k = this.scale;
    const s = this.surface();
    const canvas = s.getCanvas();
    if (this.reach) canvas.clipRect(ck.LTRBRect(...this.reach), ck.ClipOp.Intersect, false);
    // Outside strokes sit behind the content; the rest go on top.
    const strokes = (layer.effects ?? []).filter((e) => e.kind === "stroke");
    for (const stroke of strokes.filter((e) => (e.position ?? "outside") === "outside")) this.drawStroke(canvas, content, stroke, k);
    const faded = new ck.Paint();
    faded.setAlphaf(fill);
    canvas.drawImage(content, 0, 0, faded);
    faded.delete();
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

  /**
   * Blurs what's already on target within the layer's bounds, keeps it inside the layer's shape,
   * and draws it back: frosted glass. Edges clamp, so each layer only smears what lies beneath it.
   */
  private drawBackgroundBlur(target: Surface, layer: Layer, parent: Box, radius: number): void {
    const { ck } = this;
    if (layer.type === "group" || layer.type === "adjustment") {
      this.warnings.push(`layer "${layer.id}": background blur works on shapes, text and images, not ${layer.type}s`);
      return;
    }
    const coverage = this.renderBounded(this.solid(layer), parent);
    if (!coverage.image) return;
    const { x, y } = coverage;
    const [w, h] = [coverage.image.width(), coverage.image.height()];
    const backdrop = target.makeImageSnapshot([x, y, x + w, y + h] as unknown as Int32Array);
    // The blur repeats the backdrop's edge pixels, so it sees only what's beneath the layer.
    const blurred = this.blur(backdrop, radius, true);
    const s = ck.MakeSurface(w, h);
    if (!s) throw new Error("Could not allocate a render surface");
    const c = s.getCanvas();
    c.clear(ck.TRANSPARENT);
    c.drawImage(blurred, 0, 0);
    blurred.delete();
    const keep = new ck.Paint();
    keep.setBlendMode(ck.BlendMode.DstIn);
    c.drawImage(coverage.image, 0, 0, keep);
    const glass = s.makeImageSnapshot();
    s.dispose();
    const p = new ck.Paint();
    p.setAlphaf(layer.opacity ?? 1);
    target.getCanvas().drawImage(glass, x, y, p);
    this.backdrops.set(layer.id, { pixels: glass.readPixels(0, 0, this.info(ck.AlphaType.Unpremul, w, h)) as Uint8Array, x, y, w, h });
    [keep, p].forEach((paint) => paint.delete());
    [backdrop, glass, coverage.image].forEach((image) => image.delete());
  }

  /** The layer's shape at full strength, whatever its fill: what a background blur covers. */
  private solid(layer: Layer): Layer {
    const plain = { ...layer, filters: undefined, effects: undefined, mask: undefined };
    if (layer.type === "shape") return { ...plain, fill: "#FFFFFF", stroke: undefined } as Layer;
    if (layer.type === "text") return { ...plain, style: { ...layer.style, fill: "#FFFFFF" }, runs: layer.runs?.map((r) => ({ ...r, fill: undefined })) } as Layer;
    return plain as Layer;
  }

  /** A stroke around the content's alpha: grown outward, shrunk inward, or both for centred. */
  private drawStroke(canvas: Canvas, content: Image, stroke: Extract<NonNullable<Layer["effects"]>[number], { kind: "stroke" }>, k: number): void {
    const { ck } = this;
    const position = stroke.position ?? "outside";
    const w = stroke.width * k;
    const [outer, inner] = position === "outside" ? [w, 0] : position === "inside" ? [0, w] : [w / 2, w / 2];
    const ring = this.surface();
    const c = ring.getCanvas();
    if (this.reach) c.clipRect(ck.LTRBRect(...this.reach), ck.ClipOp.Intersect, false);
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
    let box: Box;
    this.lastBounds = undefined;
    if (layer.type === "group") {
      box = this.drawContent(layer, parent, s);
    } else {
      const bounded = this.renderBounded(layer, parent);
      box = bounded.box;
      this.lastBounds = [bounded.x, bounded.y, bounded.x, bounded.y];
      if (bounded.image) {
        this.lastBounds = [bounded.x, bounded.y, bounded.x + bounded.image.width(), bounded.y + bounded.image.height()];
        s.getCanvas().drawImage(bounded.image, bounded.x, bounded.y);
        bounded.image.delete();
      }
    }
    let image = s.makeImageSnapshot();
    s.dispose();
    if (layer.type === "group") {
      for (const filter of layer.filters ?? []) image = this.filter(image, filter, resolveFrame(layer.frame, parent), 0, 0);
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
    sub.release();
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
    if (layer.path) return this.drawTextOnPath(layer, parent, canvas);
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
    this.textLines.set(
      layer.id,
      para.getLineMetrics().map((m) => ({ start: m.startIndex, end: m.endExcludingWhitespaces, left: box.x + m.left, baseline: box.y + m.baseline })),
    );
    para.delete();
    this.fittedSizes.set(layer.id, size);
    return box;
  }

  /**
   * Text along a path: each character is placed at its distance along the path and turned to
   * the path's direction there, its baseline on the path. Kerning and ligatures aren't applied.
   */
  private drawTextOnPath(layer: TextLayer, parent: Box, canvas: Canvas): Box {
    const { ck } = this;
    const box = resolveFrame(layer.frame, parent);
    const path = ck.Path.MakeFromSVGString(layer.path!.d);
    if (!path) throw new Error(`text "${layer.id}": invalid path "${layer.path!.d}"`);
    path.offset(box.x, box.y);
    const contours = new ck.ContourMeasureIter(path, false, 1);
    const contour = contours.next();
    const runs = layer.runs ?? [{ text: layer.content }];
    // Measure every character with its own run's font and size.
    const glyphs: Array<{ id: number; width: number; font: Font; fill: GessoPaint }> = [];
    for (const run of runs) {
      const font = this.fontFor(run.font ?? layer.style.font, run.size ?? layer.style.size);
      const ids = font.getGlyphIDs(run.text);
      const widths = font.getGlyphWidths(ids);
      const tracking = ((run.tracking ?? layer.style.tracking ?? 0) / 1000) * (run.size ?? layer.style.size);
      ids.forEach((id, i) => glyphs.push({ id, width: widths[i]! + tracking, font, fill: run.fill ?? layer.style.fill ?? "#000000" }));
    }
    const total = glyphs.reduce((sum, g) => sum + g.width, 0);
    const length = contour?.length() ?? 0;
    const align = layer.style.align ?? "start";
    let at = (layer.path!.offset ?? 0) + (align === "center" ? (length - total) / 2 : align === "end" ? length - total : 0);
    if (at + total > length + 0.5 || at < -0.5) this.warnings.push(`text "${layer.id}" runs past the ends of its path`);
    this.drawScaled(canvas, (c) => {
      for (const g of glyphs) {
        const mid = at + g.width / 2;
        at += g.width;
        if (!contour || mid < 0 || mid > length) continue;
        const [px, py, tx, ty] = contour.getPosTan(mid);
        const blob = ck.TextBlob.MakeFromRSXformGlyphs([g.id], [tx!, ty!, px! - (tx! * g.width) / 2, py! - (ty! * g.width) / 2], g.font);
        if (!blob) continue;
        const paint = this.paint(g.fill, box);
        c.drawTextBlob(blob, 0, 0, paint);
        paint.delete();
        blob.delete();
      }
    });
    contour?.delete();
    contours.delete();
    path.delete();
    return box;
  }

  /** A CanvasKit font for a family and size, from the loaded font files (falls back to the default face). */
  private fontFor(family: string, size: number): Font {
    const { ck } = this;
    let typeface = this.typefaces.get(family);
    if (typeface === undefined) {
      const data = this.res.fontData.get(family);
      typeface = data ? ck.Typeface.MakeFreeTypeFaceFromData(data.slice().buffer) : null;
      if (!typeface) this.warnings.push(`font "${family}" is not loaded; add it as a font asset`);
      else this.disposables.push(typeface);
      this.typefaces.set(family, typeface);
    }
    const font = new ck.Font(typeface, size);
    this.disposables.push(font);
    return font;
  }

  private paragraph(layer: TextLayer, size: number, width: number | undefined): Paragraph {
    const { ck } = this;
    const { style } = layer;
    const align = { start: ck.TextAlign.Start, center: ck.TextAlign.Center, end: ck.TextAlign.End, justify: ck.TextAlign.Justify };
    if (style.fill && typeof style.fill !== "string") {
      this.warnings.push(`text "${layer.id}": gradient fills on text are not rendered yet; using its first colour`);
    }
    const fill = style.fill === undefined ? "#000000" : paintColor(style.fill);
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
    if (layer.runs) {
      // Run sizes shrink with the layer when it shrinks to fit.
      const k = size / style.size;
      for (const run of layer.runs) {
        const runSize = (run.size ?? style.size) * k;
        if (run.font && !this.res.families.has(run.font)) this.warnings.push(`text "${layer.id}": font "${run.font}" is not loaded; add it as a font asset`);
        builder.pushStyle(
          new ck.TextStyle({
            color: this.color(run.fill ?? fill),
            fontFamilies: [run.font ?? style.font],
            fontSize: runSize,
            fontStyle: { weight: { value: run.weight ?? style.weight ?? 400 } as never },
            letterSpacing: ((run.tracking ?? style.tracking ?? 0) / 1000) * runSize,
            ...(style.leading ? { heightMultiplier: (style.leading * k) / runSize, halfLeading: true } : {}),
          }),
        );
        builder.addText(run.text);
        builder.pop();
      }
    } else {
      builder.addText(layer.content);
    }
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
      const at = mask.frame ? resolveFrame(mask.frame, box) : box;
      if (mask.invert) {
        this.drawScaled(canvas, (c) => c.drawRect(ck.XYWHRect(box.x, box.y, box.w, box.h), this.paint("#ffffff", box)));
        const cut = this.paint("#ffffff", at);
        cut.setBlendMode(ck.BlendMode.DstOut);
        this.drawScaled(canvas, (c) => this.drawShape(c, mask.shape, at, cut));
      } else {
        this.drawScaled(canvas, (c) => this.drawShape(c, mask.shape, at, this.paint("#ffffff", at)));
      }
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
    const blend = layer.blend ?? "normal";
    if (blend !== "normal") {
      // Blended adjustments (a gradient map in soft light, say): draw the adjusted pixels over the
      // originals in that mode, with opacity, mask and clipping as alpha, then keep the originals' alpha.
      for (let i = 0, p = 0; i < adjusted.length; i += 4, p++) {
        let t = opacity;
        if (mask) t *= mask[p]! / 255;
        if (base) t *= base[p]! / 255;
        adjusted[i + 3] = Math.round(t * pixels[i + 3]!);
      }
      const over = this.ck.MakeImage(this.info(this.ck.AlphaType.Unpremul), adjusted, this.width * 4)!;
      const p = new this.ck.Paint();
      p.setBlendMode(this.ck.BlendMode[BLEND[blend]] as never);
      target.getCanvas().drawImage(over, 0, 0, p);
      p.delete();
      over.delete();
      // Adjustments never change coverage: put the original alpha back.
      const blended = this.readPixels(target);
      for (let i = 3; i < blended.length; i += 4) blended[i] = pixels[i]!;
      const image = this.ck.MakeImage(this.info(this.ck.AlphaType.Unpremul), blended, this.width * 4)!;
      const canvas = target.getCanvas();
      canvas.clear(this.ck.TRANSPARENT);
      canvas.drawImage(image, 0, 0);
      image.delete();
      return;
    }
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

  /** Applies one smart filter to an image placed at (x, y) in output pixels; box is the layer's box in artboard units. */
  private filter(image: Image, filter: NonNullable<Layer["filters"]>[number], box: Box, x: number, y: number): Image {
    const { ck } = this;
    const k = this.scale;
    // Long blurs run at reduced resolution, where their reach is about 24 pixels: a long smear
    // loses fine detail anyway, and this keeps large posters fast.
    const reduce = (reach: number) => Math.max(1, Math.min(8, reach / 24));
    const centre = (c: [number, number] | undefined, f: number): [number, number] => [
      ((box.x + (c?.[0] ?? 0.5) * box.w) * k - x) / f,
      ((box.y + (c?.[1] ?? 0.5) * box.h) * k - y) / f,
    ];
    const plain = (name: ShaderName, uniforms: number[]) => this.runShader(image, 1, (child) => ({ shader: shaderEffect(ck, name).makeShaderWithChildren(uniforms, [child]) }));
    switch (filter.kind) {
      case "gaussian-blur":
        return this.blur(image, filter.radius);
      case "glass": {
        const a = ((filter.angle ?? 0) * Math.PI) / 180;
        return plain("glass", [Math.cos(a), Math.sin(a), x, y, filter.size * k, filter.amount * k, filter.profile === "wave" ? 1 : 0]);
      }
      case "motion-blur": {
        const f = reduce(filter.distance * k);
        const a = (filter.angle * Math.PI) / 180;
        const d = (filter.distance * k) / f;
        return this.runShader(image, f, (child) => ({ shader: shaderEffect(ck, "motion").makeShaderWithChildren([Math.cos(a) * d, -Math.sin(a) * d], [child]) }));
      }
      case "path-blur": {
        const f = reduce(filter.distance * k);
        return this.runShader(image, f, (child, sw, sh) => {
          // Path points are fractions of the layer's box; the field is built in the reduced image's pixels.
          const path = samplePath(filter.path.map(([fx, fy]) => [((box.x + fx * box.w) * k - x) / f, ((box.y + fy * box.h) * k - y) / f] as [number, number]));
          const field = ck.MakeImage(this.info(ck.AlphaType.Unpremul, sw, sh), directionField(path, sw, sh), sw * 4)!;
          const fieldShader = field.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None);
          return { shader: shaderEffect(ck, "path").makeShaderWithChildren([(filter.distance * k) / f], [child, fieldShader]), extras: [field, fieldShader] };
        });
      }
      case "radial-blur": {
        // How far the farthest corner moves sets the working resolution.
        const [cx, cy] = centre(filter.center, 1);
        const far = Math.max(...[[0, 0], [image.width(), 0], [0, image.height()], [image.width(), image.height()]].map(([px, py]) => Math.hypot(px! - cx, py! - cy)));
        const angle = (Math.min(filter.amount, 360) * Math.PI) / 180;
        const f = reduce(filter.mode === "spin" ? far * angle : far * Math.min(filter.amount, 1));
        return this.runShader(image, f, (child) => ({
          shader:
            filter.mode === "spin"
              ? shaderEffect(ck, "spin").makeShaderWithChildren([...centre(filter.center, f), angle], [child])
              : shaderEffect(ck, "zoom").makeShaderWithChildren([...centre(filter.center, f), Math.min(filter.amount, 1)], [child]),
        }));
      }
      case "noise":
        return plain("noise", [filter.amount, Math.max(1, (filter.size ?? 1) * k), x, y, filter.monochrome === false ? 0 : 1, 0]);
      case "sharpen": {
        const soft = this.blur(image, filter.radius ?? 1, true);
        const softShader = soft.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Nearest, ck.MipmapMode.None);
        return this.runShader(image, 1, (child) => ({ shader: shaderEffect(ck, "sharpen").makeShaderWithChildren([filter.amount], [child, softShader]), extras: [softShader, soft] }));
      }
      case "twirl":
        return plain("twirl", [...centre(filter.center, 1), (filter.angle * Math.PI) / 180, (filter.radius ?? 0.5) * Math.min(box.w, box.h) * k]);
      case "wave": {
        const a = ((filter.angle ?? 0) * Math.PI) / 180;
        return plain("wave", [filter.amplitude * k, filter.wavelength * k, Math.cos(a), -Math.sin(a), x, y]);
      }
      case "shear": {
        const h = image.height();
        const range = Math.max(1, ...filter.offsets.map((o) => Math.abs(o) * k));
        return this.runShader(image, 1, (child) => {
          const rows = ck.MakeImage(this.info(ck.AlphaType.Unpremul, 1, h), shearRows(filter.offsets.map((o) => o * k), box.y * k - y, Math.max(1, box.h * k), h, range), 4)!;
          const rowShader = rows.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Nearest, ck.MipmapMode.None);
          return { shader: shaderEffect(ck, "shear").makeShaderWithChildren([range], [child, rowShader]), extras: [rowShader, rows] };
        });
      }
      case "pixelate":
        return plain("pixelate", [Math.max(1, filter.size * k), x, y]);
    }
  }

  /**
   * Draws a shader made from the image (its child) into a new image of the same size, working
   * at 1/f resolution when f > 1. The image is consumed.
   */
  private runShader(image: Image, f: number, make: (child: Shader, w: number, h: number) => { shader: Shader; extras?: Array<{ delete(): void }> }): Image {
    const { ck } = this;
    const [w, h] = [image.width(), image.height()];
    const [sw, sh] = [Math.max(1, Math.ceil(w / f)), Math.max(1, Math.ceil(h / f))];
    const linear = new ck.Paint();
    let source = image;
    if (f > 1) {
      const small = ck.MakeSurface(sw, sh);
      if (!small) throw new Error("Could not allocate a render surface");
      small.getCanvas().clear(ck.TRANSPARENT);
      small.getCanvas().drawImageRectOptions(image, ck.XYWHRect(0, 0, w, h), ck.XYWHRect(0, 0, sw, sh), ck.FilterMode.Linear, ck.MipmapMode.None, linear);
      source = small.makeImageSnapshot();
      small.dispose();
    }
    const child = source.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None);
    const { shader, extras } = make(child, sw, sh);
    const s = ck.MakeSurface(sw, sh);
    if (!s) throw new Error("Could not allocate a render surface");
    const p = new ck.Paint();
    p.setShader(shader);
    p.setBlendMode(ck.BlendMode.Src);
    s.getCanvas().drawPaint(p);
    let out = s.makeImageSnapshot();
    s.dispose();
    if (f > 1) {
      const full = ck.MakeSurface(w, h)!;
      full.getCanvas().clear(ck.TRANSPARENT);
      full.getCanvas().drawImageRectOptions(out, ck.XYWHRect(0, 0, sw, sh), ck.XYWHRect(0, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, linear);
      out.delete();
      out = full.makeImageSnapshot();
      full.dispose();
      source.delete();
    }
    [p, linear, shader, child, ...(extras ?? [])].forEach((x) => x.delete());
    image.delete();
    return out;
  }

  /** A Gaussian blur of the image; the input is consumed unless keep is set. */
  private blur(image: Image, radius: number, keep = false): Image {
    const { ck } = this;
    const sigma = radius * this.scale;
    const [w, h] = [image.width(), image.height()];
    // Edges repeat, as in Photoshop, so a layer filling the artboard doesn't fade at its edges:
    // the image is extended by the blur's reach before blurring (a save-layer blur would pull in
    // transparency instead). Layers with room around them extend their transparent margin, so
    // their edges soften as usual. Wide blurs run at reduced resolution: smooth either way, far cheaper.
    // Small blurs stay at full resolution: resampling costs precision in nearly transparent edges.
    const f = sigma >= 12 ? sigma / 6 : 1;
    const m = Math.ceil((3 * sigma) / f);
    const [sw, sh] = [Math.ceil(w / f) + 2 * m, Math.ceil(h / f) + 2 * m];
    const padded = ck.MakeSurface(sw, sh);
    if (!padded) throw new Error("Could not allocate a render surface");
    const pc = padded.getCanvas();
    pc.clear(ck.TRANSPARENT);
    const extend = new ck.Paint();
    const local = ck.Matrix.multiply(ck.Matrix.translated(m, m), ck.Matrix.scaled(1 / f, 1 / f));
    extend.setShader(image.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, ck.FilterMode.Linear, ck.MipmapMode.None, local));
    // Blur through a save layer: drawImage with an image-filter paint double-premultiplies
    // in CanvasKit 0.40, which darkens soft edges into a grey halo.
    const blur = new ck.Paint();
    blur.setImageFilter(ck.ImageFilter.MakeBlur(sigma / f, sigma / f, ck.TileMode.Decal, null));
    pc.saveLayer(blur);
    pc.drawRect(ck.XYWHRect(0, 0, sw, sh), extend);
    pc.restore();
    const blurred = padded.makeImageSnapshot();
    padded.dispose();
    const s = ck.MakeSurface(w, h);
    if (!s) throw new Error("Could not allocate a render surface");
    s.getCanvas().clear(ck.TRANSPARENT);
    const up = new ck.Paint();
    s.getCanvas().drawImageRectOptions(blurred, ck.XYWHRect(m, m, w / f, h / f), ck.XYWHRect(0, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, up);
    [extend, blur, up].forEach((x) => x.delete());
    blurred.delete();
    if (!keep) image.delete();
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
    if (paint.kind === "mesh-gradient") {
      p.setShader(this.meshShader(paint, box));
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

  /** A mesh gradient rendered at output resolution over the box, as an image shader in artboard units. */
  private meshShader(mesh: Extract<GessoPaint, { kind: "mesh-gradient" }>, box: Box) {
    const { ck } = this;
    const w = Math.max(1, Math.ceil(box.w * this.scale));
    const h = Math.max(1, Math.ceil(box.h * this.scale));
    const s = ck.MakeSurface(w, h);
    if (!s) throw new Error("Could not allocate a render surface");
    const c = s.getCanvas();
    c.clear(ck.TRANSPARENT);
    const { positions, colors, indices } = meshVertices(mesh, w, h);
    const vertices = ck.MakeVertices(ck.VertexMode.Triangles, positions, null, colors, indices);
    const p = new ck.Paint();
    p.setAntiAlias(true);
    c.drawVertices(vertices, ck.BlendMode.Dst, p);
    p.delete();
    vertices.delete();
    const image = s.makeImageSnapshot();
    s.dispose();
    const local = ck.Matrix.multiply(ck.Matrix.translated(box.x, box.y), ck.Matrix.scaled(1 / this.scale, 1 / this.scale));
    const shader = image.makeShaderOptions(ck.TileMode.Decal, ck.TileMode.Decal, ck.FilterMode.Linear, ck.MipmapMode.None, local);
    image.delete();
    return shader;
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
    const canvas = target.getCanvas();
    this.inReach(canvas, () => canvas.drawImage(image, 0, 0, p));
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

/** How far a filter can move or spread pixels beyond the layer, in artboard units. */
function filterReach(filter: NonNullable<Layer["filters"]>[number], box: Box): number {
  switch (filter.kind) {
    case "gaussian-blur":
      return 3 * filter.radius;
    case "motion-blur":
    case "path-blur":
      return filter.distance / 2;
    case "radial-blur":
      return (Math.hypot(box.w, box.h) / 2) * (filter.mode === "spin" ? Math.min(1, (filter.amount * Math.PI) / 180) : Math.min(1, filter.amount));
    case "wave":
      return Math.abs(filter.amplitude);
    case "shear":
      return Math.max(...filter.offsets.map(Math.abs));
    default:
      // Glass, twirl, noise, sharpen and pixelate stay within the layer, repeating its edges.
      return 0;
  }
}
