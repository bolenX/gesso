import type { Artboard, Doc, Frame, Layer } from "./schema.js";

// The outline view is what agents read by default, at roughly 20 to 40 tokens
// per layer. See docs/spec-v0.1.md, "The outline view".

export function outline(doc: Doc): string {
  const lines = [`${doc.id}  rev ${doc.revision}`];
  for (const artboard of doc.artboards) lines.push(...artboardLines(artboard));
  return lines.join("\n");
}

function artboardLines(artboard: Artboard): string[] {
  const { w, h } = artboard.frame;
  const lines = [`▣ ${artboard.id}  ${w}×${h}`];
  // Layers list bottom to top, matching the IR.
  lines.push(...layerLines(artboard.layers, "  "));
  return lines;
}

function layerLines(layers: Layer[], indent: string): string[] {
  const lines: string[] = [];
  layers.forEach((layer, i) => {
    const last = i === layers.length - 1;
    const isClipBase = !layer.clip && layers[i + 1]?.clip === true;
    const branch = layer.clip ? "│ ↳ " : last ? "└ " : "├ ";
    lines.push(indent + branch + describe(layer, isClipBase));
    if (layer.type === "group") {
      lines.push(...layerLines(layer.children, indent + (last ? "  " : "│ ")));
    }
  });
  return lines;
}

function describe(layer: Layer, isClipBase: boolean): string {
  const parts = [layer.id.padEnd(14), layer.type.padEnd(7)];
  if (layer.clip) parts.push("clip");
  if (layer.blend && layer.blend !== "normal") parts.push(layer.blend);
  if (layer.meta?.role) parts.push(`role=${layer.meta.role}`);
  if (isClipBase) parts.push("[clip-base]");
  if (layer.visible === false) parts.push("[hidden]");
  if (layer.meta?.locked) parts.push("[locked]");
  const label = layer.type === "text" ? layer.content : layer.meta?.description;
  if (label) parts.push(JSON.stringify(truncate(label, 40)));
  const anchor = anchorOf(layer.frame);
  if (anchor) parts.push(anchor);
  return parts.join(" ").replace(/\s+$/, "");
}

function anchorOf(frame: Frame): string | undefined {
  return "anchor" in frame ? frame.anchor : undefined;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
