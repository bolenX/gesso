import { PRESETS, withBleed, type Doc } from "@gesso/core";
import PDFDocument from "pdfkit";
import SVGtoPDF from "svg-to-pdfkit";
import { defaultAssetLoader, type AssetLoader } from "./assets.js";
import { extractFace } from "./fonts.js";
import { writeSvg } from "./svg.js";

// PDF export: each artboard becomes a page, drawn from its SVG so shapes and gradients stay
// vector and text stays selectable, with fonts embedded. For print it sizes pages at the right
// resolution, adds bleed (layers that reach the trim stretch out to the bleed edge) and crop
// marks, and records the trim and bleed boxes printers read.

export type PdfOptions = {
  loader?: AssetLoader;
  /** Pixels per inch. Defaults to 300 for print presets (A4, Letter, posters…) and 72 otherwise. */
  dpi?: number;
  /** Bleed on every side, in millimetres; 3 mm is standard. */
  bleed?: number;
  /** Crop marks at the trim corners, outside the bleed. */
  marks?: boolean;
  /** Artboards to include, in document order by default. */
  artboards?: string[];
};

export type PdfResult = { bytes: Uint8Array; warnings: string[] };

const PRINT_PRESETS = new Set(["a3", "a4", "a5", "letter", "poster-18x24", "business-card"]);
const MM = 72 / 25.4;
/** Room around the bleed for crop marks, in points. */
const SLUG = 24;

export async function writePdf(doc: Doc, options: PdfOptions = {}): Promise<PdfResult> {
  const loader = options.loader ?? defaultAssetLoader();
  const warnings: string[] = [];
  const pdf = new PDFDocument({ autoFirstPage: false, compress: true, info: { Title: doc.id, Creator: "Gesso", Producer: "Gesso" } });
  const chunks: Buffer[] = [];
  pdf.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => pdf.on("end", () => resolve()));

  // Fonts go to PDFKit directly (subset and embedded), named by family for the SVG text.
  const families = new Set<string>();
  for (const asset of Object.values(doc.assets)) {
    if (asset.kind !== "font" || !asset.family || families.has(asset.family)) continue;
    try {
      pdf.registerFont(asset.family, Buffer.from(extractFace(await loader(asset), asset.face ?? 0)));
      families.add(asset.family);
    } catch (err) {
      warnings.push(`font "${asset.family}" couldn't be embedded: ${(err as Error).message}`);
    }
  }

  const boards = options.artboards ? doc.artboards.filter((a) => options.artboards!.includes(a.id)) : doc.artboards;
  for (const artboard of boards) {
    const dpi = options.dpi ?? (artboard.preset && PRINT_PRESETS.has(artboard.preset) ? 300 : 72);
    const pt = 72 / dpi;
    const bleedPx = ((options.bleed ?? 0) * MM) / pt;
    const board = withBleed(artboard, bleedPx);
    const { svg, warnings: w } = await writeSvg({ ...doc, artboards: [board] }, board.id, { loader, target: "pdf" });
    warnings.push(...w.map((m) => `${artboard.id}: ${m}`));

    const slug = options.marks ? SLUG : 0;
    const [bw, bh] = [board.frame.w * pt, board.frame.h * pt];
    const bleed = bleedPx * pt;
    const [pw, ph] = [bw + 2 * slug, bh + 2 * slug];
    pdf.addPage({ size: [pw, ph], margin: 0 });
    SVGtoPDF(pdf, svg, slug, slug, {
      width: bw,
      height: bh,
      preserveAspectRatio: "none",
      fontCallback: (family: string) => (families.has(family.replace(/^['"]|['"]$/g, "")) ? family.replace(/^['"]|['"]$/g, "") : "Helvetica"),
      warningCallback: (m: string) => warnings.push(`${artboard.id}: ${m}`),
    });
    // Boxes, in PDF coordinates (origin bottom-left): the trim is what the printer cuts to.
    const page = pdf.page as unknown as { dictionary: { data: Record<string, unknown> } };
    page.dictionary.data.TrimBox = [slug + bleed, slug + bleed, pw - slug - bleed, ph - slug - bleed];
    page.dictionary.data.BleedBox = [slug, slug, pw - slug, ph - slug];
    if (options.marks) cropMarks(pdf, slug + bleed, slug + bleed, pw - slug - bleed, ph - slug - bleed, bleed);
    if (artboard.preset && PRESETS[artboard.preset] && !PRINT_PRESETS.has(artboard.preset) && options.bleed) {
      warnings.push(`${artboard.id}: "${artboard.preset}" is a screen size; check the page size suits print`);
    }
  }
  if (!boards.length) throw new Error("No artboards to export");
  pdf.end();
  await done;
  return { bytes: new Uint8Array(Buffer.concat(chunks)), warnings };
}

/** Hairline crop marks at the four trim corners, starting just outside the bleed. */
function cropMarks(pdf: PDFKit.PDFDocument, left: number, top: number, right: number, bottom: number, bleed: number): void {
  const gap = bleed + 3;
  const len = 12;
  pdf.save().lineWidth(0.25).strokeColor("#000000");
  for (const x of [left, right]) {
    for (const y of [top, bottom]) {
      const sx = x === left ? -1 : 1;
      const sy = y === top ? -1 : 1;
      pdf.moveTo(x + sx * gap, y).lineTo(x + sx * (gap + len), y).stroke();
      pdf.moveTo(x, y + sy * gap).lineTo(x, y + sy * (gap + len)).stroke();
    }
  }
  pdf.restore();
}
