import { describe, expect, it } from "vitest";
import { withBleed, type Artboard, type Layer } from "../src/index.js";

const rect = (id: string, frame: Layer["frame"]): Layer => ({ id, name: id, type: "shape", shape: { kind: "rect" }, fill: "#000000", frame }) as Layer;

describe("withBleed", () => {
  it("grows the artboard, keeps layers in place and stretches edge layers into the bleed", () => {
    const board: Artboard = {
      id: "a4",
      name: "A4",
      frame: { x: 0, y: 0, w: 1000, h: 1400 },
      layers: [rect("bg", { x: 0, y: 0, w: 1000, h: 1400 }), rect("logo", { x: 100, y: 100, w: 50, h: 50 }), rect("band", { x: 0, y: 1300, w: 1000, h: 100 }), rect("tag", { anchor: "top-right", margin: 40, w: "20%", h: 60 })],
    };
    const out = withBleed(board, 36);
    expect(out.frame).toEqual({ x: 0, y: 0, w: 1072, h: 1472 });
    const frame = (id: string) => out.layers.find((l) => l.id === id)!.frame;
    expect(frame("bg")).toEqual({ x: 0, y: 0, w: 1072, h: 1472 });
    expect(frame("logo")).toEqual({ x: 136, y: 136, w: 50, h: 50 });
    expect(frame("band")).toEqual({ x: 0, y: 1336, w: 1072, h: 136 });
    expect(frame("tag")).toEqual({ anchor: "top-right", margin: [76, 76], w: 200, h: 60 });
    expect(withBleed(board, 0)).toBe(board);
  });
});
