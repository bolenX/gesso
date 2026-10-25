import { createHash } from "node:crypto";
import type {
  Artboard,
  Asset,
  BlendMode,
  Doc,
  Effect,
  Filter,
  ImageLayer,
  Layer,
  Mask,
  Paint as GessoPaint,
  Shape,
  SmartLayer,
  SmartObject,
  TextLayer,
} from "@gesso/core";
import { adjustmentAssets, filterAssets, isComputedMask, paintColor } from "@gesso/core";
import { extractFace } from "./fonts.js";
import { meshVertices } from "./mesh.js";
import { DISSOLVE, setBlend } from "./blend.js";
import { blendIfWeights, computeMask } from "./masks.js";
import { boxPlane, gaussBlur, readRaster, writeRaster } from "./cpu.js";
import { applyFilter, filterReach, type FilterKit } from "./filters.js";
import type { CanvasKit, Canvas, Font, Image, ImageFilter, Paint, Paragraph, Path, RuntimeEffect, Shader, Surface, Typeface, TypefaceFontProvider } from "canvaskit-wasm";
import sharp from "sharp";
import { applyAdjustment, parseCube, type Lut3D } from "./adjust.js";
import { defaultAssetLoader, type AssetLoader } from "./assets.js";
import { loadCanvasKit } from "./canvaskit.js";
import { resolveFrame, type Box } from "./layout.js";
import { rectToQuad, type Point } from "./perspective.js";

// The evaluator. Composites each group bottom up, following docs/spec-v0.1.md,
// "Compositing order within a group": content, smart filters, mask, then clip
// groups, adjustments or a plain blend onto the backdrop. Surfaces are 8-bit
// sRGB, so blending happens in gamma-encoded space like Photoshop.
// Per-node caching (the render DAG) comes later; this renders every layer.

export type RenderOptions = {
  scale?: number;
  loader?: AssetLoader;
  /** Computed masks that read what's below a layer, as recorded by a full render (Rendered.masks); layer parts need them. */
  masks?: Map<string, Uint8Array>;
};
export type Rendered = {
  artboard: string;
  width: number;
  height: number;
  pixels: Uint8Array;
  warnings: string[];
  /** Background blurs as drawn, by layer id: unpremultiplied RGBA within a box in output pixels. PSD export bakes these. */
  backdrops?: Map<string, Backdrop>;
  /** Computed masks that read what's below their layer, by layer id: coverage per output pixel. */
  masks?: Map<string, Uint8Array>;
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
  /** A compound shape's combined outline as SVG path data in artboard pixels. */
  svgPath?: string;
  /** Pattern overlays as pixels clipped to the layer (Photoshop files can't carry Gesso's patterns): straight RGBA in pixelBox-style boxes. */
  overlays?: Array<{ pixels: Uint8Array; box: { x: number; y: number; w: number; h: number }; opacity: number; blend?: BlendMode }>;
};

/** A 2D affine transform: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];

/** The layer's flip, skew and rotation around the centre of its box, or undefined when it has none. */
export function layerTransform(layer: { rotation?: number; flip?: "horizontal" | "vertical" | "both"; skew?: [number, number] }, box: Box): Affine | undefined {
  if (!layer.rotation && !layer.flip && !layer.skew) return undefined;
  const rad = ((layer.rotation ?? 0) * Math.PI) / 180;
  const sx = layer.flip === "horizontal" || layer.flip === "both" ? -1 : 1;
  const sy = layer.flip === "vertical" || layer.flip === "both" ? -1 : 1;
  const [tx, ty] = (layer.skew ?? [0, 0]).map((deg) => Math.tan((deg * Math.PI) / 180)) as [number, number];
  const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
  // Rotation × skew × flip.
  const [a2, b2, c2, d2] = [sx, ty * sx, tx * sy, sy];
  const [a, b, c, d] = [cos * a2 - sin * b2, sin * a2 + cos * b2, cos * c2 - sin * d2, sin * c2 + cos * d2];
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
    compositor.givenMasks = options.masks;
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
  /** Parsed colour lookup tables (.cube) by asset id. */
  luts: Map<string, Lut3D>;
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
  const lutIds = new Set<string>();
  const visit = (layers: Layer[]) => {
    for (const layer of layers) {
      if (layer.type === "image") used.add(layer.asset);
      if (layer.mask?.kind === "raster") used.add(layer.mask.asset);
      for (const effect of layer.effects ?? []) if (effect.kind === "pattern-overlay") used.add(effect.asset);
      for (const filter of layer.filters ?? []) filterAssets(filter).forEach((id) => used.add(id));
      if (layer.type === "adjustment") adjustmentAssets(layer.adjustment).forEach((id) => lutIds.add(id));
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

  const luts = new Map<string, Lut3D>();
  try {
    for (const id of lutIds) {
      const asset = doc.assets[id];
      if (!asset) throw new Error(`Missing asset "${id}": import the .cube file with asset_import, or change the Color Lookup that uses it`);
      luts.set(id, parseCube(new TextDecoder().decode(await loadAsset(loader, id, asset))));
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
    luts,
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
  /** Computed masks read from what was below their layer, recorded for layer parts (PSD export). */
  masks = new Map<string, Uint8Array>();
  /** Masks recorded by an earlier full render, used when rendering layer parts (nothing is below them then). */
  givenMasks?: Map<string, Uint8Array>;
  /** The surface the layer being composited goes onto: what's below it. */
  private below: Surface | undefined;
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
    return { artboard: artboard.id, width: this.width, height: this.height, pixels, warnings: this.warnings, backdrops: this.backdrops, masks: this.masks };
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
        if (layer.type === "shape" && layer.shape.kind === "compound") {
          // The combined outline, in artboard pixels: vector in SVG and PSD.
          const combined = this.shapePath(layer.shape, part.box);
          part.svgPath = combined.toSVGString();
          combined.delete();
          part.paths = this.cubicPaths(part.svgPath, { x: 0, y: 0, w: 0, h: 0 });
        }
        part.matrix = compose(inherited, layerTransform(layer, part.box));
        if (part.quad && part.matrix) part.quad = part.quad.map(([x, y]) => transformPoint(part.matrix, x, y));
        if (layer.mask) part.mask = this.readImageAlpha(this.maskImage(layer.mask, part.box, parent, layer.id));
        const patterns = (layer.effects ?? []).filter((e): e is Extract<Effect, { kind: "pattern-overlay" }> => e.kind === "pattern-overlay");
        if (patterns.length && layer.type !== "adjustment") part.overlays = this.patternParts(layer, parent, patterns);
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
    const outer = this.below;
    try {
      this.compositeOnto(layers, parent, target);
    } finally {
      this.below = outer;
    }
  }

  private compositeOnto(layers: Layer[], parent: Box, target: Surface): void {
    for (let i = 0; i < layers.length; i++) {
      this.below = target;
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

      if (clipped.length === 0 && !base.blendIf && this.drawDirect(base, parent, target)) continue;

      const content = this.renderLayer(base, parent);
      this.reach = this.reachOf(base, this.lastBounds);
      try {
        const fill = base.fillOpacity ?? 1;
        const styled = base.effects?.length || fill < 1 ? this.withEffectsAbove(content, base, fill, resolveFrame(base.frame, parent)) : content;
        if (base.effects?.length) {
          // Shadows and glows follow the styled shape, strokes included, and ignore fill opacity, as in Photoshop.
          const shape = fill < 1 ? this.withEffectsAbove(content, base, 1, undefined, false) : styled;
          this.drawEffectsBelow(target, shape, base);
          if (shape !== styled) shape.delete();
          for (const effect of base.effects) if (effect.kind === "background-blur") this.drawBackgroundBlur(target, base, parent, effect.radius);
        }
        if (clipped.length === 0) {
          const shown = base.blendIf ? this.blendIf(styled, base, target) : styled;
          this.drawImage(target, shown, base.blend, base.opacity);
          if (shown !== styled) shown.delete();
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
          this.below = group;
          const image = this.renderLayer(layer, parent);
          s.getCanvas().drawImage(image, 0, 0);
          image.delete();
          this.drawImage(s, content, undefined, 1, "DstIn");
          const clippedImage = s.makeImageSnapshot();
          s.dispose();
          const shown = layer.blendIf ? this.blendIf(clippedImage, layer, group) : clippedImage;
          this.drawImage(group, shown, layer.blend, layer.opacity);
          if (shown !== clippedImage) shown.delete();
          clippedImage.delete();
        }
        const groupImage = group.makeImageSnapshot();
        group.dispose();
        const shown = base.blendIf ? this.blendIf(groupImage, base, target) : groupImage;
        this.drawImage(target, shown, base.blend, base.opacity);
        if (shown !== groupImage) shown.delete();
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
      if (e.kind === "bevel" && e.style && e.style !== "inner-bevel") grow = Math.max(grow, ((e.size ?? 5) * 2 + (e.soften ?? 0) + 2) * k);
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
    if (layer.type === "group" || layer.type === "adjustment" || layer.mask || layer.effects?.length || layer.blend === "dissolve") return false;
    const canvas = target.getCanvas();
    const blend = layer.blend ?? "normal";
    const opacity = (layer.opacity ?? 1) * (layer.fillOpacity ?? 1);
    if (layer.filters?.length) {
      // Filtered layers render bounded, then blend in as an image.
      const { image, x, y } = this.renderBounded(layer, parent);
      if (image) {
        const p = new this.ck.Paint();
        setBlend(this.ck, p, blend);
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
      setBlend(this.ck, p, blend);
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
  /**
   * The content with its fill opacity and the effects that sit on or around it: overlays, satin,
   * inner glow and shadow, bevel, and strokes, in Photoshop's order. `box` aligns gradient
   * overlays; `interiors: false` keeps only strokes (the shape shadows and glows follow).
   */
  private withEffectsAbove(content: Image, layer: Layer, fill = 1, box?: Box, interiors = true): Image {
    const { ck } = this;
    const k = this.scale;
    const s = this.surface();
    const canvas = s.getCanvas();
    if (this.reach) canvas.clipRect(ck.LTRBRect(...this.reach), ck.ClipOp.Intersect, false);
    const effects = layer.effects ?? [];
    // Outside strokes sit behind the content; the rest go on top.
    const strokes = effects.filter((e) => e.kind === "stroke");
    for (const stroke of strokes.filter((e) => (e.position ?? "outside") === "outside")) this.drawStroke(canvas, content, stroke, k);
    const faded = new ck.Paint();
    faded.setAlphaf(fill);
    canvas.drawImage(content, 0, 0, faded);
    faded.delete();
    if (interiors) {
      const of = <K extends Effect["kind"]>(kind: K) => effects.filter((e): e is Extract<Effect, { kind: K }> => e.kind === kind);
      for (const e of of("pattern-overlay")) this.drawInterior(canvas, content, this.patternImage(e), e.blend, e.opacity ?? 1);
      for (const e of of("gradient-overlay")) this.drawInterior(canvas, content, this.gradientImage(e, box ?? { x: 0, y: 0, w: this.width / k, h: this.height / k }), e.blend, e.opacity ?? 1);
      for (const e of of("color-overlay")) {
        const flat = this.surface();
        flat.getCanvas().clear(this.color(e.color));
        this.drawInterior(canvas, content, this.snapshot(flat), e.blend, e.opacity ?? 1);
      }
      for (const e of of("satin")) this.drawInterior(canvas, content, this.satinImage(content, e), e.blend ?? "multiply", e.opacity ?? 0.5);
      for (const e of of("inner-glow")) this.drawInterior(canvas, content, this.innerGlowImage(content, e), e.blend ?? "screen", e.opacity ?? 0.75);
      for (const e of of("inner-shadow")) this.drawInterior(canvas, content, this.innerShadowImage(content, e), e.blend ?? "multiply", e.opacity ?? 0.75);
      for (const e of of("bevel")) this.drawBevel(canvas, content, e);
    }
    for (const stroke of strokes.filter((e) => (e.position ?? "outside") !== "outside")) this.drawStroke(canvas, content, stroke, k);
    return this.snapshot(s);
  }

  /** Each pattern overlay clipped to the layer's own pixels, cropped, for a PSD's clipped layers. */
  private patternParts(layer: Layer, parent: Box, patterns: Array<Extract<Effect, { kind: "pattern-overlay" }>>): NonNullable<LayerPart["overlays"]> {
    const { ck } = this;
    const content = this.renderLayer(layer, parent, false);
    const out: NonNullable<LayerPart["overlays"]> = [];
    for (const e of patterns) {
      const s = this.surface();
      const pattern = this.patternImage(e);
      s.getCanvas().drawImage(pattern, 0, 0);
      pattern.delete();
      const keep = new ck.Paint();
      keep.setBlendMode(ck.BlendMode.DstIn);
      s.getCanvas().drawImage(content, 0, 0, keep);
      keep.delete();
      const image = this.snapshot(s);
      const found = cropToContent(image.readPixels(0, 0, this.info(ck.AlphaType.Unpremul)) as Uint8Array, this.width, this.height);
      image.delete();
      if (found) out.push({ pixels: found.pixels, box: found.box, opacity: e.opacity ?? 1, ...(e.blend ? { blend: e.blend } : {}) });
    }
    content.delete();
    return out;
  }

  /** The surface's pixels as an image; the surface is disposed. */
  private snapshot(s: Surface): Image {
    const image = s.makeImageSnapshot();
    s.dispose();
    return image;
  }

  /** Draws an effect image (consumed) only where the content is, in a blend mode. */
  private drawInterior(canvas: Canvas, content: Image, effect: Image, blend: BlendMode | undefined, opacity: number, outside = false): void {
    const { ck } = this;
    const s = this.surface();
    const c = s.getCanvas();
    c.drawImage(effect, 0, 0);
    effect.delete();
    const keep = new ck.Paint();
    keep.setBlendMode(outside ? ck.BlendMode.DstOut : ck.BlendMode.DstIn);
    c.drawImage(content, 0, 0, keep);
    keep.delete();
    const clipped = this.snapshot(s);
    const p = new ck.Paint();
    setBlend(ck, p, blend);
    p.setAlphaf(opacity);
    canvas.drawImage(clipped, 0, 0, p);
    p.delete();
    clipped.delete();
  }

  /** The content's shape run through an image filter (which colours it), as an image. */
  private shapeThrough(source: Image, filter: ImageFilter, blend?: keyof CanvasKit["BlendMode"]): Image {
    const { ck } = this;
    const s = this.surface();
    const p = new ck.Paint();
    p.setImageFilter(filter);
    if (blend) p.setBlendMode(ck.BlendMode[blend] as never);
    s.getCanvas().drawImage(source, 0, 0, p);
    p.delete();
    filter.delete();
    return this.snapshot(s);
  }

  /** Everything outside the content, filled (its inverse coverage). */
  private outsideOf(content: Image): Image {
    const { ck } = this;
    const s = this.surface();
    const c = s.getCanvas();
    c.clear(ck.WHITE);
    const cut = new ck.Paint();
    cut.setBlendMode(ck.BlendMode.DstOut);
    c.drawImage(content, 0, 0, cut);
    cut.delete();
    return this.snapshot(s);
  }

  private innerShadowImage(content: Image, e: Extract<Effect, { kind: "inner-shadow" }>): Image {
    const { ck } = this;
    const k = this.scale;
    const size = (e.size ?? 5) * k;
    const choke = e.choke ?? 0;
    const angle = ((e.angle ?? 120) * Math.PI) / 180;
    const d = (e.distance ?? 5) * k;
    // The outside, shifted away from the light and blurred, falls inside the edge as shadow.
    const outside = this.outsideOf(content);
    const grow = choke > 0 ? ck.ImageFilter.MakeDilate(size * choke, size * choke, null) : null;
    const sigma = (size * (1 - choke)) / 2;
    const image = this.shapeThrough(outside, ck.ImageFilter.MakeDropShadowOnly(-Math.cos(angle) * d, Math.sin(angle) * d, sigma, sigma, this.color(e.color ?? "#000000"), grow));
    outside.delete();
    return image;
  }

  private innerGlowImage(content: Image, e: Extract<Effect, { kind: "inner-glow" }>): Image {
    const { ck } = this;
    const size = (e.size ?? 5) * this.scale;
    const choke = e.choke ?? 0;
    const sigma = (size * (1 - choke)) / 2;
    const color = this.color(e.color ?? "#FFFFBE");
    if (e.source === "center") {
      // From the centre: the shape shrunk by the size, blurred, so the glow fades towards the edges.
      const shrink = ck.ImageFilter.MakeErode(size * (1 - choke * 0.5), size * (1 - choke * 0.5), null);
      return this.shapeThrough(content, ck.ImageFilter.MakeDropShadowOnly(0, 0, Math.max(0.01, sigma), Math.max(0.01, sigma), color, shrink));
    }
    const outside = this.outsideOf(content);
    const grow = choke > 0 ? ck.ImageFilter.MakeDilate(size * choke, size * choke, null) : null;
    const image = this.shapeThrough(outside, ck.ImageFilter.MakeDropShadowOnly(0, 0, Math.max(0.01, sigma), Math.max(0.01, sigma), color, grow));
    outside.delete();
    return image;
  }

  private satinImage(content: Image, e: Extract<Effect, { kind: "satin" }>): Image {
    const { ck } = this;
    const k = this.scale;
    const sigma = Math.max(0.01, ((e.size ?? 14) * k) / 2);
    const angle = ((e.angle ?? 19) * Math.PI) / 180;
    const [dx, dy] = [Math.cos(angle) * (e.distance ?? 11) * k, -Math.sin(angle) * (e.distance ?? 11) * k];
    const color = this.color(e.color ?? "#000000");
    // Two blurred copies of the shape, shifted opposite ways; where exactly one covers is the satin.
    const s = this.surface();
    const c = s.getCanvas();
    const shifted = (x: number, y: number, mode: keyof CanvasKit["BlendMode"]) => {
      const p = new ck.Paint();
      const f = ck.ImageFilter.MakeDropShadowOnly(x, y, sigma, sigma, color, null);
      p.setImageFilter(f);
      p.setBlendMode(ck.BlendMode[mode] as never);
      c.drawImage(content, 0, 0, p);
      p.delete();
      f.delete();
    };
    shifted(dx, dy, "SrcOver");
    shifted(-dx, -dy, "Xor");
    const satin = this.snapshot(s);
    if (!e.invert) return satin;
    const inv = this.surface();
    inv.getCanvas().clear(color);
    const cut = new ck.Paint();
    cut.setBlendMode(ck.BlendMode.DstOut);
    inv.getCanvas().drawImage(satin, 0, 0, cut);
    cut.delete();
    satin.delete();
    return this.snapshot(inv);
  }

  private gradientImage(e: Extract<Effect, { kind: "gradient-overlay" }>, box: Box): Image {
    const sc = (e.scale ?? 100) / 100;
    const at = { x: box.x + (box.w * (1 - sc)) / 2, y: box.y + (box.h * (1 - sc)) / 2, w: box.w * sc, h: box.h * sc };
    let stops = e.reverse ? e.stops.map((st) => ({ offset: 1 - st.offset, color: st.color })).reverse() : e.stops;
    // Reflected: the gradient runs out from the middle both ways.
    if (e.style === "reflected") stops = [...stops.map((st) => ({ offset: 0.5 - st.offset / 2, color: st.color })).reverse(), ...stops.map((st) => ({ offset: 0.5 + st.offset / 2, color: st.color }))];
    const paint = this.paint(e.style === "radial" ? { kind: "radial-gradient", stops } : { kind: "linear-gradient", angle: e.angle ?? 90, stops }, at);
    const s = this.surface();
    this.drawScaled(s.getCanvas(), (c) => c.drawRect(this.ck.XYWHRect(0, 0, this.width / this.scale, this.height / this.scale), paint));
    paint.delete();
    return this.snapshot(s);
  }

  private patternImage(e: Extract<Effect, { kind: "pattern-overlay" }>): Image {
    const { ck } = this;
    const image = this.res.images.get(e.asset);
    const s = this.surface();
    if (!image) {
      this.warnings.push(`pattern overlay: image "${e.asset}" isn't loaded`);
      return this.snapshot(s);
    }
    const sc = ((e.scale ?? 100) / 100) * this.scale;
    const shader = image.makeShaderOptions(ck.TileMode.Repeat, ck.TileMode.Repeat, ck.FilterMode.Linear, ck.MipmapMode.None, ck.Matrix.scaled(sc, sc));
    const p = new ck.Paint();
    p.setShader(shader);
    s.getCanvas().drawPaint(p);
    p.delete();
    shader.delete();
    return this.snapshot(s);
  }

  /**
   * Bevel & Emboss: the content's coverage, blurred by the size, is a height map; its slopes,
   * lit from the angle and altitude, give highlights (screen) and shadows (multiply), inside the
   * edge, outside it, or both.
   */
  private drawBevel(canvas: Canvas, content: Image, e: Extract<Effect, { kind: "bevel" }>): void {
    const { ck } = this;
    const k = this.scale;
    const [w, h] = [this.width, this.height];
    const size = Math.max(1, (e.size ?? 5) * k);
    const alpha = this.readImageAlpha(content, false);
    const height = new Float32Array(w * h);
    for (let i = 0; i < height.length; i++) height[i] = alpha[i]! / 255;
    const rr = Math.sqrt((12 * (size / 2) ** 2) / 3 + 1) / 2 - 0.5;
    const H = boxPlane(boxPlane(boxPlane(height, w, h, rr), w, h, rr), w, h, rr);
    const style = e.style ?? "inner-bevel";
    const steep = ((e.depth ?? 100) / 100) * size * 0.6 * (e.direction === "down" ? -1 : 1);
    const [ang, alt] = [((e.angle ?? 120) * Math.PI) / 180, ((e.altitude ?? 30) * Math.PI) / 180];
    const [lx, ly, lz] = [Math.cos(alt) * Math.cos(ang), -Math.cos(alt) * Math.sin(ang), Math.sin(alt)];
    const lights = [new Float32Array(w * h), new Float32Array(w * h)];
    const darks = [new Float32Array(w * h), new Float32Array(w * h)];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const gx = (H[y * w + Math.min(w - 1, x + 1)]! - H[y * w + Math.max(0, x - 1)]!) / 2;
        const gy = (H[Math.min(h - 1, y + 1) * w + x]! - H[Math.max(0, y - 1) * w + x]!) / 2;
        // Inside and outside (pillow emboss sinks the outside the other way).
        for (let side = 0; side < 2; side++) {
          const dir = style === "pillow-emboss" && side === 1 ? -1 : 1;
          const [nx, ny] = [-gx * steep * dir, -gy * steep * dir];
          const shade = (nx * lx + ny * ly + lz) / Math.sqrt(nx * nx + ny * ny + 1) - lz;
          lights[side]![i] = Math.min(1, Math.max(0, shade * 2.5));
          darks[side]![i] = Math.min(1, Math.max(0, -shade * 2.5));
        }
      }
    const soften = (e.soften ?? 0) * k;
    const toImage = (plane: Float32Array, color: string) => {
      const p = soften > 0 ? boxPlane(boxPlane(plane, w, h, soften / 2), w, h, soften / 2) : plane;
      const [r, g, b] = [1, 3, 5].map((o) => parseInt(color.slice(o, o + 2), 16));
      const px = new Uint8Array(w * h * 4);
      for (let i = 0; i < p.length; i++) px.set([r!, g!, b!, Math.round(p[i]! * 255)], i * 4);
      return ck.MakeImage(this.info(ck.AlphaType.Unpremul), px, w * 4)!;
    };
    const sides: Array<[number, boolean]> = style === "inner-bevel" ? [[0, false]] : style === "outer-bevel" ? [[0, true]] : [[0, false], [1, true]];
    for (const [side, outside] of sides) {
      this.drawInterior(canvas, content, toImage(lights[side]!, e.highlight ?? "#FFFFFF"), "screen", e.highlightOpacity ?? 0.75, outside);
      this.drawInterior(canvas, content, toImage(darks[side]!, e.shadow ?? "#000000"), "multiply", e.shadowOpacity ?? 0.75, outside);
    }
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
    const below = this.below;
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
      const mask = this.maskImage(layer.mask, box, parent, layer.id, below);
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
    if ((layer.quad && layer.type !== "smart") || layer.warp) return this.drawDistorted(layer, parent, s, canvas);
    if (!layer.rotation && !layer.flip && !layer.skew) return this.drawUntransformed(layer, parent, s, canvas);
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

  /**
   * Distort / Perspective (a corner pin) or Warp (a smooth mesh): the layer is drawn flat, then
   * mapped onto the quad with a homography, or through a mesh interpolated from the warp grid.
   */
  private drawDistorted(layer: Layer, parent: Box, s: Surface | undefined, canvas: Canvas): Box {
    const { ck } = this;
    const k = this.scale;
    const flat = this.surface();
    const box = this.drawUntransformed(layer, parent, layer.type === "group" ? flat : s, flat.getCanvas());
    const image = this.snapshot(flat);
    const [bx, by, bw, bh] = [box.x * k, box.y * k, box.w * k, box.h * k];
    if (layer.quad && layer.type !== "smart") {
      const corners = layer.quad.map(([x, y]) => [(parent.x + x) * k, (parent.y + y) * k] as [number, number]) as [Point, Point, Point, Point];
      const h = rectToQuad(bw, bh, corners);
      // Homography after moving the box's corner to the origin.
      const m = [h[0]!, h[1]!, h[2]! - h[0]! * bx - h[1]! * by, h[3]!, h[4]!, h[5]! - h[3]! * bx - h[4]! * by, h[6]!, h[7]!, h[8]! - h[6]! * bx - h[7]! * by];
      const p = new ck.Paint();
      p.setAntiAlias(true);
      canvas.save();
      canvas.concat(m);
      canvas.drawImageRectOptions(image, ck.XYWHRect(bx, by, bw, bh), ck.XYWHRect(bx, by, bw, bh), ck.FilterMode.Linear, ck.MipmapMode.None, p);
      canvas.restore();
      p.delete();
    } else {
      const { positions, texs, indices } = warpMesh(layer.warp!, bx, by, bw, bh);
      const vertices = ck.MakeVertices(ck.VertexMode.Triangles, positions, texs, null, indices);
      const shader = image.makeShaderOptions(ck.TileMode.Decal, ck.TileMode.Decal, ck.FilterMode.Linear, ck.MipmapMode.None);
      const p = new ck.Paint();
      p.setAntiAlias(true);
      p.setShader(shader);
      // Rotation, flip and skew still apply, after the warp.
      const turn = layerTransform(layer, box);
      canvas.save();
      if (turn) canvas.concat(this.deviceMatrix(turn));
      canvas.drawVertices(vertices, ck.BlendMode.Dst, p);
      canvas.restore();
      [p, shader, vertices].forEach((x) => x.delete());
    }
    image.delete();
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
      const path = this.shapePath(shape, box);
      c.drawPath(path, paint);
      path.delete();
    }
    paint.delete();
  }

  /** A shape as a path placed in the box; compound shapes are combined part by part. */
  private shapePath(shape: Shape, box: Box): Path {
    const { ck } = this;
    if (shape.kind === "compound") {
      const ops = { add: ck.PathOp.Union, subtract: ck.PathOp.Difference, intersect: ck.PathOp.Intersect, exclude: ck.PathOp.XOR };
      let result: Path | undefined;
      for (const part of shape.parts) {
        const piece = this.shapePath(part.shape, part.frame ? resolveFrame(part.frame, box) : box);
        if (!result) {
          result = piece;
          continue;
        }
        const combined = ck.Path.MakeFromOp(result, piece, ops[part.op ?? "add"]);
        result.delete();
        piece.delete();
        result = combined ?? new ck.Path();
      }
      return result ?? new ck.Path();
    }
    const path = new ck.Path();
    const rect = ck.XYWHRect(box.x, box.y, box.w, box.h);
    if (shape.kind === "rect") {
      if (shape.radius) path.addRRect(ck.RRectXY(rect, shape.radius, shape.radius));
      else path.addRect(rect);
    } else if (shape.kind === "ellipse") {
      path.addOval(rect);
    } else {
      path.delete();
      const parsed = ck.Path.MakeFromSVGString(shape.d);
      if (!parsed) throw new Error(`Invalid SVG path "${shape.d}"`);
      parsed.offset(box.x, box.y);
      return parsed;
    }
    return path;
  }

  /** Builds a coverage image whose alpha is the mask. */
  private maskImage(mask: Mask, box: Box, parent: Box, layerId?: string, below?: Surface): Image {
    const { ck } = this;
    if (isComputedMask(mask)) {
      const coverage = this.computedMask(mask, parent, layerId, below);
      const rgba = new Uint8Array(coverage.length * 4).fill(255);
      for (let i = 0; i < coverage.length; i++) rgba[i * 4 + 3] = coverage[i]!;
      let image = ck.MakeImage(this.info(ck.AlphaType.Unpremul), rgba, this.width * 4)!;
      if (mask.feather) image = this.blur(image, mask.feather);
      return image;
    }
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
    } else if (mask.kind === "luminance-of") {
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
  /** A computed mask's coverage per output pixel, from a layer or from what's below. */
  private computedMask(mask: Extract<Mask, { kind: "luminosity" | "color-range" | "channel" }>, parent: Box, layerId: string | undefined, below: Surface | undefined): Uint8Array {
    const from = mask.source ?? "below";
    if (from !== "below") {
      const source = this.byId.get(from);
      if (!source) throw new Error(`Mask refers to missing layer "${from}"`);
      const image = this.renderLayer(source, parent, false);
      const pixels = image.readPixels(0, 0, this.info(this.ck.AlphaType.Unpremul)) as Uint8Array;
      image.delete();
      return computeMask(pixels, mask);
    }
    const given = layerId ? this.givenMasks?.get(layerId) : undefined;
    if (given && given.length === this.width * this.height) return given;
    const coverage = computeMask(below ? this.readPixels(below) : new Uint8Array(this.width * this.height * 4), mask);
    if (layerId) this.masks.set(layerId, coverage);
    return coverage;
  }

  /** Blend If: a copy of the layer image faded where it, or what's below, falls outside the ranges. */
  private blendIf(image: Image, layer: Layer, below: Surface): Image {
    const { ck } = this;
    const pixels = image.readPixels(0, 0, this.info(ck.AlphaType.Unpremul)) as Uint8Array;
    const weights = blendIfWeights(pixels, this.readPixels(below), layer.blendIf!);
    for (let i = 0; i < weights.length; i++) pixels[i * 4 + 3] = Math.round(pixels[i * 4 + 3]! * weights[i]!);
    return ck.MakeImage(this.info(ck.AlphaType.Unpremul), pixels, this.width * 4)!;
  }

  private adjust(layer: Extract<Layer, { type: "adjustment" }>, parent: Box, target: Surface, clipBase: Image | null): void {
    const pixels = this.readPixels(target);
    const adjusted = pixels.slice();
    applyAdjustment(adjusted, layer.adjustment, this.res.luts);

    const opacity = layer.opacity ?? 1;
    const mask = layer.mask ? this.readImageAlpha(this.maskImage(layer.mask, resolveFrame(layer.frame, parent), parent, layer.id, target)) : null;
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
      setBlend(this.ck, p, blend);
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
  private filter(image: Image, filter: Filter, box: Box, x: number, y: number): Image {
    return applyFilter(this.kit, image, filter, box, x, y);
  }

  /** What the filter module needs from this compositor. */
  private get kit(): FilterKit {
    return {
      ck: this.ck,
      scale: this.scale,
      images: this.res.images,
      warnings: this.warnings,
      runShader: (image, f, make) => this.runShader(image, f, make),
      blur: (image, radius, keep) => this.blur(image, radius, keep),
    };
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
    // Skia's software blur takes a slow path below sigma 2; a direct kernel on the CPU is far faster.
    if (sigma < 2) {
      const out = writeRaster(ck, gaussBlur(readRaster(ck, image, false), sigma));
      if (!keep) image.delete();
      return out;
    }
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
    if (mode) p.setBlendMode(this.ck.BlendMode[mode] as never);
    else setBlend(this.ck, p, blend);
    // Dissolve shows each pixel fully or not at all, with odds set by its opacity.
    const dissolved = !mode && blend === "dissolve" ? this.dissolve(image, opacity) : undefined;
    p.setAlphaf(dissolved ? 1 : opacity);
    const canvas = target.getCanvas();
    this.inReach(canvas, () => canvas.drawImage(dissolved ?? image, 0, 0, p));
    dissolved?.delete();
    p.delete();
  }

  /** The image with its alpha dithered to fully on or off (Dissolve), at the given opacity. Anchored to the artboard. */
  private dissolve(image: Image, opacity: number): Image {
    const { ck } = this;
    let effect = dissolveEffects.get(ck);
    if (!effect) dissolveEffects.set(ck, (effect = ck.RuntimeEffect.Make(DISSOLVE)!));
    return this.runShader(copyImage(ck, image), 1, (child) => ({ shader: effect.makeShaderWithChildren([0, 0, opacity], [child]) }));
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

const dissolveEffects = new WeakMap<CanvasKit, RuntimeEffect>();

/** A copy of an image (runShader consumes its input). */
function copyImage(ck: CanvasKit, image: Image): Image {
  const s = ck.MakeSurface(image.width(), image.height())!;
  s.getCanvas().clear(ck.TRANSPARENT);
  s.getCanvas().drawImage(image, 0, 0);
  const out = s.makeImageSnapshot();
  s.dispose();
  return out;
}

/**
 * A triangle mesh through a warp grid (fractions of the box), smoothed with Catmull-Rom splines
 * between the grid points and subdivided finely enough to curve. Texture coordinates are the
 * undistorted box.
 */
export function warpMesh(grid: Array<Array<[number, number]>>, bx: number, by: number, bw: number, bh: number) {
  const rows = grid.length;
  const cols = Math.min(...grid.map((r) => r.length));
  const pt = (r: number, c: number) => grid[Math.max(0, Math.min(rows - 1, r))]![Math.max(0, Math.min(cols - 1, c))]!;
  const cr = (p0: number, p1: number, p2: number, p3: number, t: number) =>
    0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  const at = (u: number, v: number): [number, number] => {
    // u, v in grid units: spline along each nearby row, then down the column.
    const [c, r] = [Math.min(cols - 2, Math.floor(u)), Math.min(rows - 2, Math.floor(v))];
    const [tu, tv] = [u - c, v - r];
    const rowAt = (rr: number) => [0, 1].map((axis) => cr(pt(rr, c - 1)[axis]!, pt(rr, c)[axis]!, pt(rr, c + 1)[axis]!, pt(rr, c + 2)[axis]!, tu)) as [number, number];
    const [a, b, d, e] = [rowAt(r - 1), rowAt(r), rowAt(r + 1), rowAt(r + 2)];
    return [cr(a[0], b[0], d[0], e[0], tv), cr(a[1], b[1], d[1], e[1], tv)];
  };
  const [nx, ny] = [(cols - 1) * 8, (rows - 1) * 8];
  const positions: number[] = [];
  const texs: number[] = [];
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const [fx, fy] = at((i / nx) * (cols - 1), (j / ny) * (rows - 1));
      positions.push(bx + fx * bw, by + fy * bh);
      texs.push(bx + (i / nx) * bw, by + (j / ny) * bh);
    }
  const indices: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const v = j * (nx + 1) + i;
      indices.push(v, v + 1, v + nx + 1, v + 1, v + nx + 2, v + nx + 1);
    }
  return { positions, texs, indices };
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
