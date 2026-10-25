import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { Asset } from "@gesso/core";
import { fontUri, parseCube, readFontFaces } from "@gesso/render";
import sharp from "sharp";
import { download, resolvePath } from "./paths.js";

// Brings an image, font or colour lookup table (.cube) into a document. Downloads and pasted data are saved in the
// Gesso folder under assets/, so the document keeps working offline and after restarts;
// local files are referenced where they are.

export type ImportRequest = {
  id: string;
  /** A path (relative to the Gesso folder, or absolute) or an http(s) URL. */
  source?: string;
  /** Base64 file contents, for hosts that can't share a path. */
  data?: string;
  kind?: "image" | "font" | "mask" | "lut";
  /** Face in a .ttc collection. */
  face?: number;
  description?: string;
};

const FONT_TYPES: Record<string, string> = { "font/ttf": ".ttf", "font/otf": ".otf", "font/collection": ".ttc", "application/font-sfnt": ".ttf" };

/** Confined (hosted), local paths must be inside baseDir and downloads must reach public addresses. */
export async function importAsset(request: ImportRequest, baseDir: string, confined = false): Promise<Asset> {
  const { id, source, data } = request;
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new Error(`Asset id "${id}" should be short letters, digits, - or _, e.g. "hero-photo"`);
  if (!source && !data) throw new Error("asset_import needs a source (path or URL) or data (base64)");

  let bytes: Uint8Array;
  let uri: string | undefined;
  let extension = "";
  if (data) {
    bytes = Buffer.from(data.replace(/^data:[^,]*,/, ""), "base64");
    if (bytes.length === 0) throw new Error("data is empty or isn't base64");
  } else if (/^https?:\/\//i.test(source!)) {
    const res = await download(source!, confined);
    bytes = res.bytes;
    extension = FONT_TYPES[res.type?.split(";")[0] ?? ""] ?? extname(new URL(source!).pathname).toLowerCase();
  } else {
    const path = resolvePath(baseDir, source!, confined);
    if (!existsSync(path)) {
      throw new Error(confined ? `No file "${source}" in your workspace. Upload it first, or pass a URL or data.` : `No file at ${path}. Paths are relative to the Gesso folder (${baseDir}) unless absolute.`);
    }
    bytes = await readFile(path);
    uri = fontUri(path, baseDir);
  }

  const asset = await describe(bytes, request);
  if (uri === undefined) {
    // Downloaded or pasted: keep a copy in the Gesso folder.
    const format = asset.kind === "font" || asset.kind === "lut" ? undefined : (await sharp(bytes).metadata()).format;
    const ext = asset.kind === "lut" ? ".cube" : format ? `.${format === "jpeg" ? "jpg" : format}` : /^\.(ttf|otf|ttc|otc)$/.test(extension) ? extension : ".ttf";
    const dir = join(baseDir, "assets");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${id}${ext}`), bytes);
    uri = `assets/${id}${ext}`;
  }
  return { uri, ...asset };
}

async function describe(bytes: Uint8Array, request: ImportRequest): Promise<Omit<Asset, "uri">> {
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
  const description = request.description ? { description: request.description } : {};
  const text = request.kind === "lut" || request.kind === undefined ? new TextDecoder().decode(bytes.subarray(0, 4096)) : "";
  if (request.kind === "lut" || /^\s*(#.*\n\s*)*(TITLE|LUT_3D_SIZE|LUT_1D_SIZE|DOMAIN_M)/m.test(text)) {
    try {
      parseCube(new TextDecoder().decode(bytes));
    } catch (err) {
      throw new Error(`That file isn't a 3D colour lookup table Gesso can read (.cube): ${(err as Error).message}`);
    }
    return { kind: "lut", hash, ...description };
  }
  if (request.kind !== "image" && request.kind !== "mask") {
    const faces = await readFontFaces(async (offset, length) => bytes.subarray(offset, offset + length)).catch(() => []);
    if (faces.length) {
      const index = request.face ?? 0;
      const face = faces.find((f) => f.face === index);
      if (!face) throw new Error(`The font file has ${faces.length} faces (0–${faces.length - 1}); face ${index} doesn't exist`);
      return {
        kind: "font",
        hash,
        family: face.fullName,
        ...(face.postscriptName ? { postscriptName: face.postscriptName } : {}),
        ...(index ? { face: index } : {}),
        ...description,
      };
    }
    if (request.kind === "font") throw new Error("That file isn't a font Gesso can read (.ttf, .otf or .ttc)");
  }
  const meta = await sharp(bytes)
    .metadata()
    .catch(() => undefined);
  if (!meta?.width || !meta.height) throw new Error("That file isn't an image or font Gesso can read (PNG, JPEG, WebP, AVIF, GIF, TIFF, SVG, TTF, OTF, TTC)");
  return { kind: request.kind ?? "image", hash, width: meta.width, height: meta.height, ...description };
}
