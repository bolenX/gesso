declare module "svg-to-pdfkit" {
  export default function SVGtoPDF(doc: PDFKit.PDFDocument, svg: string, x?: number, y?: number, options?: Record<string, unknown>): void;
}
