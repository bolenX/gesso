import { PRESETS, type Doc, type Layer } from "@gesso/core";
import { resolveFrame, type Box } from "@gesso/render";

// Preflight: layout problems an agent can't always see in a small preview, found from the document itself.

export type Issue = { layer: string; severity: "error" | "warning" | "info"; issue: string };

/** Roles whose content must stay readable and uncovered: text, logos and calls to action. */
const KEY_ROLES = new Set(["logo", "headline", "body", "cta"]);

const SOCIAL = /instagram|tiktok|facebook|linkedin|x-|youtube|pinterest|og-image|story|reel/;
const PRINT = /^(a3|a4|a5|letter|poster|business-card)/;

/** Smallest readable type for the artboard: 28 px on social sizes, 6 pt at 300 dpi in print, else 2% of the shorter side. */
function minTextSize(preset: string | undefined, shorter: number): number {
  if (preset && SOCIAL.test(preset)) return 28;
  if (preset && PRINT.test(preset)) return 25;
  return Math.max(10, Math.round(shorter * 0.02));
}

export async function preflight(doc: Doc, artboardId: string): Promise<Issue[]> {
  const artboard = doc.artboards.find((a) => a.id === artboardId)!;
  const { w, h } = artboard.frame;
  const preset = artboard.preset;
  const safe = preset ? PRESETS[preset]?.safe : undefined;
  const minSize = minTextSize(preset, Math.min(w, h));
  const issues: Issue[] = [];
  const add = (layer: Layer, severity: Issue["severity"], issue: string) => issues.push({ layer: layer.id, severity, issue });

  const visit = (layers: Layer[], parent: Box, hidden: boolean) => {
    for (const layer of layers) {
      const box = resolveFrame(layer.frame, parent);
      const off = hidden || layer.visible === false || layer.opacity === 0;
      if (layer.visible === false && !hidden) add(layer, "info", "hidden");
      else if (layer.opacity === 0 && !hidden) add(layer, "info", "opacity is 0, so it's invisible");
      const key = layer.type === "text" || KEY_ROLES.has(layer.meta?.role ?? "");
      if (!off && key) {
        const cut = box.x < -0.5 || box.y < -0.5 || box.x + box.w > w + 0.5 || box.y + box.h > h + 0.5;
        if (cut) add(layer, "error", `extends past the artboard (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}×${Math.round(box.h)} on ${w}×${h}), so it's cut off`);
        if (safe) {
          const [top, right, bottom, left] = safe;
          const sides = [box.y < top && "top", box.x + box.w > w - right && "right", box.y + box.h > h - bottom && "bottom", box.x < left && "left"].filter(Boolean);
          if (sides.length) add(layer, "warning", `inside the ${preset} safe-zone margin (${sides.join(", ")}): the platform's buttons or captions may cover it. Keep within x ${left}–${w - right}, y ${top}–${h - bottom}`);
        }
      }
      if (!off && layer.type === "text") {
        if (!layer.content.trim()) add(layer, "warning", "text layer is empty");
        const sizes = [layer.style.size, ...(layer.runs ?? []).map((r) => r.size ?? layer.style.size)];
        const smallest = Math.min(...sizes);
        if (smallest < minSize) add(layer, "warning", `type at ${smallest} px is small for this size (at least ${minSize} px reads well)`);
      }
      if (!off && layer.type === "image") {
        const asset = doc.assets[layer.asset];
        if (asset?.width && asset.height) {
          const [sx, sy] = [box.w / asset.width, box.h / asset.height];
          const fit = layer.fit ?? "cover";
          const scale = fit === "contain" ? Math.min(sx, sy) : fit === "fill" ? Math.max(sx, sy) : Math.max(sx, sy);
          if (scale > 1.25) add(layer, "warning", `image is enlarged ${scale.toFixed(1)}× past its pixels (${asset.width}×${asset.height}), so it will look soft; use a larger source or a gen_prepare upscale job`);
        }
      }
      if (layer.type === "group") visit(layer.children, box, off);
    }
  };
  visit(artboard.layers, { x: 0, y: 0, w, h }, false);
  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]);
}
