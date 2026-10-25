import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artboard, Doc, Layer, Op } from "@gesso/core";
import { resolveFrame, type AssetLoader, type Box } from "@gesso/render";
import sharp from "sharp";

// Gesso never calls an image model. gen_prepare writes a provider-neutral job (images,
// mask, sizes, prompt) to the Gesso folder; the agent runs it with whatever tool the
// user has connected (Magnific, Higgsfield, an API), imports the result with
// asset_import under the id given here, and applies the patch ops returned with the job.

export type JobKind = "expand" | "generate" | "remove-background" | "upscale" | "fill";

/** A region of a layer: centre and size as fractions of its box, ellipse (default) or rectangle. */
export type Region = { at: [number, number]; size: [number, number]; shape?: "ellipse" | "rect" };

export type JobRequest = {
  kind: JobKind;
  artboard: string;
  /** The image layer to work on; for "generate", the layer (any type) whose frame the new image fills. */
  layer: string;
  prompt?: string;
  /** Upscale factor. */
  factor?: number;
  /** For fill: where to fill (Generative Fill / Remove); the prompt says what goes there, or nothing to remove what's there. */
  regions?: Region[];
};

export type Job = {
  job: JobKind;
  id: string;
  doc: string;
  revision: number;
  artboard: string;
  layer: string;
  /** Files in the job folder, absolute paths. */
  files: Record<string, string>;
  /** Size the result should have, in pixels. */
  targetSize: [number, number];
  aspectRatio: string;
  /** For expand: how far to extend the source image on each side, in its own pixels. */
  expandBy?: { left: number; top: number; right: number; bottom: number };
  prompt?: string;
  negative?: string;
  /** Import the result under this id with asset_import, then apply `ops` with canvas_patch. */
  assetId: string;
  ops: Op[];
  steps: string[];
};

const MAX_SIDE = 4096;
const NEGATIVE = "text, letters, logos, watermark, borders, frames, duplicated subject";

export async function prepareJob(doc: Doc, request: JobRequest, baseDir: string, loader: AssetLoader): Promise<Job> {
  const artboard = doc.artboards.find((a) => a.id === request.artboard);
  if (!artboard) throw new Error(`No artboard "${request.artboard}". Artboards: ${doc.artboards.map((a) => a.id).join(", ")}`);
  const found = findLayer(artboard, request.layer);
  if (!found) throw new Error(`No layer "${request.layer}" in "${artboard.id}"`);
  const { layer, parent } = found;
  const id = `${request.kind}-${layer.id}-r${doc.revision}`;
  const dir = join(baseDir, "jobs", id);
  await mkdir(dir, { recursive: true });
  const files: Record<string, string> = {};
  const save = async (name: string, data: Buffer) => {
    files[name.replace(/\.png$/, "")] = join(dir, name);
    await writeFile(join(dir, name), data);
  };
  const provenance = (prompt?: string) => ({ op: request.kind, provider: "<the tool you used>", ...(prompt ? { prompt } : {}), sourceRevision: doc.revision });
  const base = { id, doc: doc.id, revision: doc.revision, artboard: artboard.id, layer: layer.id, files, assetId: id };

  if (request.kind === "generate") {
    const box = resolveFrame(layer.frame, parent);
    const [w, h] = fit(box.w, box.h, Math.max(box.w, box.h, 1024));
    const prompt = request.prompt ?? layer.meta?.description ?? "";
    if (!prompt) throw new Error('generate needs a prompt (or a meta.description on the layer) describing the image');
    const newLayer = { id: `${layer.id}-image`, name: `${layer.name} (generated)`, type: "image", asset: id, fit: "cover", frame: layer.frame, meta: { ...(layer.meta?.role ? { role: layer.meta.role } : {}), provenance: provenance(prompt) } };
    const job: Job = {
      ...base,
      job: "generate",
      targetSize: [w, h],
      aspectRatio: ratio(w, h),
      prompt,
      negative: NEGATIVE,
      ops: layer.type === "image" ? [{ op: "insert", after: `#${layer.id}`, layer: newLayer }, { op: "set", target: `#${layer.id}`, path: "visible", value: false }] : [{ op: "insert", after: `#${layer.id}`, layer: newLayer }],
      steps: steps("Generate an image from the prompt at the target size (or the nearest aspect ratio the tool offers)", id),
    };
    await writeFile(join(dir, "job.json"), JSON.stringify(job, null, 2));
    files.job = join(dir, "job.json");
    return job;
  }

  if (layer.type !== "image") throw new Error(`${request.kind} works on image layers; "${layer.id}" is ${layer.type}`);
  const asset = doc.assets[layer.asset];
  if (!asset) throw new Error(`Layer "${layer.id}" uses missing asset "${layer.asset}"`);
  const bytes = await loader(asset);
  const meta = await sharp(bytes).metadata();
  const [iw, ih] = [meta.width!, meta.height!];
  await save("source.png", await sharp(bytes).png().toBuffer());
  const box = resolveFrame(layer.frame, parent, { aspect: iw / ih });

  if (request.kind === "fill") {
    const regions = request.regions ?? [];
    if (!regions.length) throw new Error('fill needs "regions": where to fill, as { at: [x, y], size: [w, h] } fractions of the layer');
    // Where the layer's box shows the image: the crop for cover, the letterbox for contain.
    const fitMode = layer.fit ?? "cover";
    const [fx, fy] = layer.focus ?? [0.5, 0.5];
    let view = { x: 0, y: 0, w: iw, h: ih };
    if (fitMode === "cover" || fitMode === "content-aware") {
      const s = Math.max(box.w / iw, box.h / ih);
      view = { x: (iw - box.w / s) * fx, y: (ih - box.h / s) * fy, w: box.w / s, h: box.h / s };
    } else if (fitMode === "contain") {
      const s = Math.min(box.w / iw, box.h / ih);
      view = { x: -(box.w / s - iw) / 2, y: -(box.h / s - ih) / 2, w: box.w / s, h: box.h / s };
    }
    const shapes = regions.map((r) => {
      const [cx, cy] = [view.x + r.at[0] * view.w, view.y + r.at[1] * view.h];
      const [rw, rh] = [(r.size[0] * view.w) / 2, (r.size[1] * view.h) / 2];
      return r.shape === "rect"
        ? `<rect x="${cx - rw}" y="${cy - rh}" width="${2 * rw}" height="${2 * rh}" fill="#fff"/>`
        : `<ellipse cx="${cx}" cy="${cy}" rx="${rw}" ry="${rh}" fill="#fff"/>`;
    });
    // White = fill. The mask is a touch larger than the regions so the result blends in.
    const grow = Math.max(2, Math.round(Math.min(iw, ih) * 0.01));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${iw}" height="${ih}"><rect width="100%" height="100%" fill="#000"/><g stroke="#fff" stroke-width="${grow * 2}">${shapes.join("")}</g></svg>`;
    await save("mask.png", await sharp(Buffer.from(svg)).png().toBuffer());
    const prompt = request.prompt ?? "";
    const feather = Math.max(4, Math.round(Math.min(box.w, box.h) * 0.01));
    // The filled image goes above the original, showing only the regions (a feathered vector mask).
    const parts = regions.map((r) => ({
      shape: { kind: r.shape === "rect" ? "rect" : "ellipse" },
      frame: round({ x: (r.at[0] - r.size[0] / 2) * box.w - feather, y: (r.at[1] - r.size[1] / 2) * box.h - feather, w: r.size[0] * box.w + 2 * feather, h: r.size[1] * box.h + 2 * feather }),
    }));
    const filled = {
      id: `${layer.id}-fill`,
      name: `${layer.name} (filled)`,
      type: "image",
      asset: id,
      fit: layer.fit ?? "cover",
      ...(layer.focus ? { focus: layer.focus } : {}),
      frame: layer.frame,
      mask: { kind: "vector", shape: { kind: "compound", parts }, feather },
      meta: { provenance: provenance(prompt || "remove") },
    };
    const job: Job = {
      ...base,
      job: "fill",
      targetSize: [iw, ih],
      aspectRatio: ratio(iw, ih),
      ...(prompt ? { prompt } : {}),
      negative: NEGATIVE,
      ops: [{ op: "insert", after: `#${layer.id}`, layer: filled }],
      steps: steps(
        prompt
          ? `Inpaint source.png where mask.png is white with: "${prompt}" (Generative Fill), keeping the result the same size`
          : "Inpaint source.png where mask.png is white, removing what's there and continuing the surroundings (Remove / Content-Aware Fill), keeping the result the same size. For small blemishes, the heal or content-aware-fill filter does this without a model",
        id,
      ),
    };
    await writeFile(join(dir, "job.json"), JSON.stringify(job, null, 2));
    files.job = join(dir, "job.json");
    return job;
  }

  if (request.kind === "expand") {
    // Show the whole source inside the frame, centred, and generate what's around it.
    const k = Math.min(box.w / iw, box.h / ih);
    const [cw, ch] = [Math.round(box.w / k), Math.round(box.h / k)];
    const left = Math.floor((cw - iw) / 2);
    const top = Math.floor((ch - ih) / 2);
    const expandBy = { left, top, right: cw - iw - left, bottom: ch - ih - top };
    if (Math.max(...Object.values(expandBy)) < 2) throw new Error(`"${layer.id}" already fits its frame without cropping; nothing to expand`);
    const [pw, ph] = fit(cw, ch, MAX_SIDE);
    const s = pw / cw;
    const placed = { left: Math.round(left * s), top: Math.round(top * s), width: Math.round(iw * s), height: Math.round(ih * s) };
    const scaled = await sharp(bytes).resize(placed.width, placed.height).png().toBuffer();
    await save("padded.png", await sharp({ create: { width: pw, height: ph, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: scaled, left: placed.left, top: placed.top }]).png().toBuffer());
    // White where to generate, overlapping the source a little so the provider can blend the seam.
    const overlap = Math.round(Math.min(placed.width, placed.height) * 0.02);
    const keep = await sharp({ create: { width: Math.max(1, placed.width - 2 * overlap), height: Math.max(1, placed.height - 2 * overlap), channels: 3, background: "#000000" } }).png().toBuffer();
    await save("mask.png", await sharp({ create: { width: pw, height: ph, channels: 3, background: "#FFFFFF" } }).composite([{ input: keep, left: placed.left + overlap, top: placed.top + overlap }]).png().toBuffer());

    const prompt = request.prompt ?? `Extend the scene naturally beyond its edges${layer.meta?.description ? ` (${layer.meta.description})` : ""}. Continue the background, lighting and textures; add no new objects.`;
    const feather = Math.max(8, Math.round(Math.min(box.w, box.h) * 0.03));
    // The source stays on top, inside a feathered mask, over the generated plate, so its pixels are untouched.
    const inner = { x: box.x - parent.x + (box.w - iw * k) / 2, y: box.y - parent.y + (box.h - ih * k) / 2, w: iw * k, h: ih * k };
    const job: Job = {
      ...base,
      job: "expand",
      targetSize: [pw, ph],
      aspectRatio: ratio(pw, ph),
      expandBy,
      prompt,
      negative: NEGATIVE,
      ops: [
        { op: "insert", before: `#${layer.id}`, layer: { id: `${layer.id}-plate`, name: `${layer.name} (expanded)`, type: "image", asset: id, fit: "fill", frame: absolute(box, parent), meta: { role: "background", provenance: provenance(prompt) } } },
        { op: "set", target: `#${layer.id}`, path: "frame", value: round(inner) },
        { op: "set", target: `#${layer.id}`, path: "fit", value: "fill" },
        // Inset by the feather so the source fades out completely by its own edge.
        { op: "set", target: `#${layer.id}`, path: "mask", value: { kind: "vector", shape: { kind: "path", d: insetRect(inner.w, inner.h, feather) }, feather } },
      ],
      steps: steps(
        `Outpaint: either send padded.png with mask.png (white = generate), or send source.png and extend it by expandBy (left ${expandBy.left}, top ${expandBy.top}, right ${expandBy.right}, bottom ${expandBy.bottom} px) to aspect ${ratio(pw, ph)}. ${Math.max(expandBy.left + expandBy.right, 0) > iw || expandBy.top + expandBy.bottom > ih ? "This more than doubles the image: if the result looks stretched or repetitive, expand in two smaller steps." : ""}`.trim(),
        id,
      ),
    };
    await writeFile(join(dir, "job.json"), JSON.stringify(job, null, 2));
    files.job = join(dir, "job.json");
    return job;
  }

  const factor = request.kind === "upscale" ? (request.factor ?? 2) : 1;
  const above = { id: `${layer.id}-${request.kind === "upscale" ? "upscaled" : "cutout"}`, name: `${layer.name} (${request.kind === "upscale" ? "upscaled" : "cut out"})`, type: "image", asset: id, fit: layer.fit ?? "cover", ...(layer.focus ? { focus: layer.focus } : {}), frame: layer.frame, meta: { ...(layer.meta?.role ? { role: layer.meta.role } : {}), provenance: provenance() } };
  const job: Job = {
    ...base,
    job: request.kind,
    targetSize: [iw * factor, ih * factor],
    aspectRatio: ratio(iw, ih),
    ops: [
      { op: "insert", after: `#${layer.id}`, layer: above },
      { op: "set", target: `#${layer.id}`, path: "visible", value: false },
    ],
    steps: steps(request.kind === "upscale" ? `Upscale source.png ${factor}× (to ${iw * factor}×${ih * factor})` : "Remove the background from source.png, keeping a transparent PNG at the same size", id),
  };
  await writeFile(join(dir, "job.json"), JSON.stringify(job, null, 2));
  files.job = join(dir, "job.json");
  return job;
}

function steps(run: string, id: string): string[] {
  return [
    `${run}, with an image tool the user has connected (for example Magnific or Higgsfield) or one they name. Gesso doesn't generate images itself.`,
    `Save or download the result, then call asset_import with id "${id}" and the result's path or URL.`,
    'Apply `ops` with canvas_patch at the current revision, replacing "<the tool you used>" with the tool and model.',
    "Render with canvas_render and check the seams, the subject and that nothing new appeared.",
  ];
}

function findLayer(artboard: Artboard, id: string): { layer: Layer; parent: Box } | undefined {
  const walk = (layers: Layer[], parent: Box): { layer: Layer; parent: Box } | undefined => {
    for (const layer of layers) {
      if (layer.id === id) return { layer, parent };
      if (layer.type === "group") {
        const found = walk(layer.children, resolveFrame(layer.frame, parent));
        if (found) return found;
      }
    }
    return undefined;
  };
  return walk(artboard.layers, { x: 0, y: 0, w: artboard.frame.w, h: artboard.frame.h });
}

const insetRect = (w: number, h: number, by: number) => {
  const r = (v: number) => Math.round(v * 100) / 100;
  return `M ${r(by)} ${r(by)} H ${r(w - by)} V ${r(h - by)} H ${r(by)} Z`;
};

/** The resolved box as a frame relative to the parent. */
const absolute = (box: Box, parent: Box) => round({ x: box.x - parent.x, y: box.y - parent.y, w: box.w, h: box.h });

const round = (b: Box) => ({ x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100, w: Math.round(b.w * 100) / 100, h: Math.round(b.h * 100) / 100 });

/** Scales (w, h) so the long side is at most max, keeping the ratio. */
function fit(w: number, h: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

/** The nearest common aspect ratio name (within 1%), which is what image tools ask for. */
function ratio(w: number, h: number): string {
  const common = ["1:1", "4:5", "5:4", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9", "9:21", "1.91:1"];
  const value = w / h;
  const near = common.find((r) => {
    const [a, b] = r.split(":").map(Number) as [number, number];
    return Math.abs(a / b / value - 1) < 0.01;
  });
  return near ?? `${value.toFixed(3)}:1`;
}
