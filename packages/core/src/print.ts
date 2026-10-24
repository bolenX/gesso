import type { Artboard, Frame, Layer } from "./schema.js";

// Print bleed: the artboard grows by `bleed` on every side, its layers keep their places
// relative to the trim, and layers that reach a trim edge stretch out to the bleed edge so
// nothing white shows if the cut wanders.

export function withBleed(artboard: Artboard, bleed: number): Artboard {
  if (bleed <= 0) return artboard;
  const { w, h } = artboard.frame;
  const shift = (layer: Layer): Layer => ({ ...layer, frame: bleedFrame(layer.frame, w, h, bleed) }) as Layer;
  return { ...artboard, frame: { ...artboard.frame, w: w + 2 * bleed, h: h + 2 * bleed }, layers: artboard.layers.map(shift) };
}

function bleedFrame(frame: Frame, w: number, h: number, b: number): Frame {
  if ("x" in frame) {
    // Absolute: move in from the new edge, and stretch any side that touches the trim.
    const edge = 0.5;
    const left = frame.x <= edge ? b + frame.x : 0;
    const top = frame.y <= edge ? b + frame.y : 0;
    const right = frame.x + frame.w >= w - edge ? b + (w - frame.x - frame.w) : 0;
    const bottom = frame.y + frame.h >= h - edge ? b + (h - frame.y - frame.h) : 0;
    return { x: frame.x + b - left, y: frame.y + b - top, w: frame.w + left + right, h: frame.h + top + bottom };
  }
  // Anchored: percentages keep meaning the trim size, and margins grow by the bleed.
  const px = (v: number | string | undefined, of: number) => (typeof v === "string" ? (parseFloat(v) / 100) * of : v);
  const [mx, my] = Array.isArray(frame.margin) ? frame.margin : [frame.margin ?? 0, frame.margin ?? 0];
  const out = { ...frame, margin: [mx + b, my + b] as [number, number] };
  if (frame.w !== undefined) out.w = px(frame.w, w);
  if (frame.h !== undefined) out.h = px(frame.h, h);
  return out;
}
