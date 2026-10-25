import type { BlendMode } from "@gesso/core";
import type { Blender, CanvasKit, Paint } from "canvaskit-wasm";

// Blend modes. The 16 standard modes are Skia's own; Photoshop's others are SkSL blenders that
// apply Photoshop's formula to straight colour and composite the result the standard way
// (source over, with the mode's colour where both layers cover). Dissolve isn't a colour
// formula: the layer's alpha is dithered to fully on or off first (see dissolveShader), then it
// draws normally.

export const SKIA_BLEND: Partial<Record<BlendMode, keyof CanvasKit["BlendMode"]>> = {
  normal: "SrcOver",
  dissolve: "SrcOver",
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

/** Photoshop's formulas on straight colour: cb is the backdrop (below), cs the source (the layer). */
const FORMULAS: Partial<Record<BlendMode, string>> = {
  "linear-burn": "cb + cs - 1.0",
  "linear-dodge": "cb + cs",
  "linear-light": "cb + 2.0 * cs - 1.0",
  subtract: "cb - cs",
  divide: "half3(cs.r > 0.0 ? cb.r / cs.r : (cb.r > 0.0 ? 1.0 : 0.0), cs.g > 0.0 ? cb.g / cs.g : (cb.g > 0.0 ? 1.0 : 0.0), cs.b > 0.0 ? cb.b / cs.b : (cb.b > 0.0 ? 1.0 : 0.0))",
  "pin-light": "mix(max(cb, 2.0 * cs - 1.0), min(cb, 2.0 * cs), half3(lessThan(cs, half3(0.5))))",
  "vivid-light": "half3(vivid(cb.r, cs.r), vivid(cb.g, cs.g), vivid(cb.b, cs.b))",
  "hard-mix": "half3(greaterThanEqual(cb + cs, half3(1.0)))",
  "darker-color": "(cs.r + cs.g + cs.b < cb.r + cb.g + cb.b) ? cs : cb",
  "lighter-color": "(cs.r + cs.g + cs.b > cb.r + cb.g + cb.b) ? cs : cb",
};

const blenderSource = (formula: string) => `
  half vivid(half b, half s) {
    if (s <= 0.5) return s <= 0.0 ? (b >= 1.0 ? 1.0 : 0.0) : 1.0 - (1.0 - b) / (2.0 * s);
    return s >= 1.0 ? (b <= 0.0 ? 0.0 : 1.0) : b / (2.0 * (1.0 - s));
  }
  half4 main(half4 src, half4 dst) {
    half3 cs = src.a > 0.0 ? src.rgb / src.a : half3(0.0);
    half3 cb = dst.a > 0.0 ? dst.rgb / dst.a : half3(0.0);
    half3 mixed = clamp(${formula}, 0.0, 1.0);
    return half4(src.rgb * (1.0 - dst.a) + dst.rgb * (1.0 - src.a) + src.a * dst.a * mixed, src.a + dst.a * (1.0 - src.a));
  }`;

const blenders = new WeakMap<CanvasKit, Map<BlendMode, Blender>>();

/** Sets a paint to composite in a blend mode. */
export function setBlend(ck: CanvasKit, paint: Paint, blend: BlendMode | undefined): void {
  const mode = blend ?? "normal";
  const native = SKIA_BLEND[mode];
  if (native) return paint.setBlendMode(ck.BlendMode[native] as never);
  let cache = blenders.get(ck);
  if (!cache) blenders.set(ck, (cache = new Map()));
  let blender = cache.get(mode);
  if (!blender) {
    const errors: string[] = [];
    const effect = ck.RuntimeEffect.MakeForBlender(blenderSource(FORMULAS[mode]!), (e) => errors.push(e));
    if (!effect) throw new Error(`Could not compile the ${mode} blend mode: ${errors.join("; ")}`);
    blender = effect.makeBlender([]);
    cache.set(mode, blender);
  }
  paint.setBlender(blender);
}

/** SkSL for Dissolve: each pixel is fully shown or hidden, with odds set by its opacity. Pattern anchored to the artboard. */
export const DISSOLVE = `uniform shader img; uniform float2 origin; uniform float opacity;
  half4 main(float2 p) {
    half4 c = img.eval(p);
    float2 q = floor(p + origin);
    float r = fract(sin(dot(q, float2(12.9898, 78.233))) * 43758.5453);
    return r < float(c.a) * opacity ? half4(c.rgb / max(c.a, 0.0001), 1.0) : half4(0.0);
  }`;
