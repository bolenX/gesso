import type { Frame } from "@gesso/core";

export type Box = { x: number; y: number; w: number; h: number };

/** Natural size of a layer's content, used when an anchored frame leaves w or h open. */
export type Intrinsic = { w?: number; h?: number; aspect?: number };

const len = (value: number | string | undefined, of: number): number | undefined => {
  if (value === undefined) return undefined;
  return typeof value === "number" ? value : (parseFloat(value) / 100) * of;
};

/**
 * Converts a frame into an absolute box. Frames resolve within their parent's box
 * (the artboard, or the enclosing group), so intent frames reflow with the parent.
 */
export function resolveFrame(frame: Frame, parent: Box, intrinsic: Intrinsic = {}): Box {
  if (!("anchor" in frame)) return { x: parent.x + frame.x, y: parent.y + frame.y, w: frame.w, h: frame.h };

  const [mx, my] = Array.isArray(frame.margin) ? frame.margin : [frame.margin ?? 0, frame.margin ?? 0];
  const aspect = frame.aspect ?? intrinsic.aspect;
  let w = len(frame.w, parent.w);
  let h = len(frame.h, parent.h);
  if (w === undefined && h !== undefined && aspect) w = h * aspect;
  if (h === undefined && w !== undefined && aspect) h = w / aspect;
  w ??= intrinsic.w ?? parent.w - 2 * mx;
  h ??= aspect ? w / aspect : (intrinsic.h ?? parent.h - 2 * my);

  const [vertical, horizontal] = splitAnchor(frame.anchor);
  const x =
    horizontal === "left" ? parent.x + mx : horizontal === "right" ? parent.x + parent.w - mx - w : parent.x + (parent.w - w) / 2;
  const y =
    vertical === "top" ? parent.y + my : vertical === "bottom" ? parent.y + parent.h - my - h : parent.y + (parent.h - h) / 2;
  return { x, y, w, h };
}

function splitAnchor(anchor: string): ["top" | "middle" | "bottom", "left" | "center" | "right"] {
  if (anchor === "center") return ["middle", "center"];
  if (anchor === "left" || anchor === "right") return ["middle", anchor];
  if (anchor === "top" || anchor === "bottom") return [anchor, "center"];
  const [v, h] = anchor.split("-") as ["top" | "bottom", "left" | "right"];
  return [v, h];
}
