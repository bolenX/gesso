import { describe, expect, it } from "vitest";
import { applyOps, reflowArtboard, type Artboard, type Layer } from "../src/index.js";
import { promo } from "./fixtures.js";

const rect = (id: string, frame: Layer["frame"]): Layer => ({ id, name: id, type: "shape", shape: { kind: "rect", radius: 10 }, fill: "#000000", frame }) as Layer;
const board = (layers: Layer[]): Artboard => ({ id: "post", name: "Post", frame: { x: 0, y: 0, w: 1000, h: 1000 }, layers });

describe("reflowArtboard", () => {
  it("keeps layers to their edge, centres the rest and stretches full-bleed layers", () => {
    const { layers, scale } = reflowArtboard(
      board([
        rect("bg", { x: 0, y: 0, w: 1000, h: 1000 }),
        rect("logo", { x: 900, y: 20, w: 80, h: 80 }),
        rect("title", { x: 300, y: 450, w: 400, h: 100 }),
        rect("band", { x: 0, y: 850, w: 1000, h: 150 }),
      ]),
      { w: 1000, h: 2000 },
    );
    expect(scale).toBe(1);
    const frame = (id: string) => layers.find((l) => l.id === id)!.frame;
    expect(frame("bg")).toEqual({ x: 0, y: 0, w: 1000, h: 2000 });
    expect(frame("logo")).toEqual({ x: 900, y: 20, w: 80, h: 80 });
    expect(frame("title")).toEqual({ x: 300, y: 950, w: 400, h: 100 });
    expect(frame("band")).toEqual({ x: 0, y: 1850, w: 1000, h: 150 });
  });

  it("scales sizes, type and radii evenly when the artboard shrinks", () => {
    const text = { id: "t", name: "t", type: "text", content: "Hi", style: { font: "A", size: 100 }, frame: { anchor: "top", margin: 40, w: "80%", h: 120 } } as Layer;
    const { layers } = reflowArtboard(board([rect("card", { x: 100, y: 100, w: 200, h: 200 }), text]), { w: 500, h: 800 });
    expect(layers[0]).toMatchObject({ frame: { x: 50, y: 50, w: 100, h: 100 }, shape: { radius: 5 } });
    expect(layers[1]).toMatchObject({ frame: { anchor: "top", margin: 20, w: "80%", h: 60 }, style: { size: 50 } });
  });

  it("scales filter sizes with the layout, within each parameter's range", () => {
    const card = { ...rect("card", { x: 100, y: 100, w: 200, h: 200 }), filters: [{ kind: "box-blur", radius: 8 }, { kind: "crystallize", size: 4 }, { kind: "displace", map: "m", scale: [20, 10] }, { kind: "pinch", amount: 50 }] } as Layer;
    const { layers } = reflowArtboard(board([card]), { w: 500, h: 500 });
    expect(layers[0]!.filters).toEqual([{ kind: "box-blur", radius: 4 }, { kind: "crystallize", size: 3 }, { kind: "displace", map: "m", scale: [10, 5] }, { kind: "pinch", amount: 50 }]);
  });

  it("scales layer style sizes with the layout", () => {
    const card = { ...rect("card", { x: 100, y: 100, w: 200, h: 200 }), effects: [{ kind: "drop-shadow", distance: 10, size: 20, angle: 90 }, { kind: "bevel", size: 8, soften: 2, depth: 150 }, { kind: "stroke", color: "#000000", width: 4 }] } as Layer;
    const { layers } = reflowArtboard(board([card]), { w: 500, h: 500 });
    expect(layers[0]!.effects).toEqual([{ kind: "drop-shadow", distance: 5, size: 10, angle: 90 }, { kind: "bevel", size: 4, soften: 1, depth: 150 }, { kind: "stroke", color: "#000000", width: 2 }]);
  });

  it("adds and removes artboards through the artboard op", () => {
    const extra = { id: "story", name: "Story", frame: { x: 2000, y: 0, w: 1080, h: 1920 }, layers: [] };
    const added = applyOps(promo, [{ op: "artboard", id: "story", artboard: extra }]).doc;
    expect(added.artboards.map((a) => a.id)).toContain("story");
    expect(applyOps(added, [{ op: "artboard", id: "story", artboard: null }]).doc.artboards).toHaveLength(promo.artboards.length);
    expect(() => applyOps(promo, [{ op: "artboard", id: promo.artboards[0]!.id, artboard: null }])).toThrow(/at least one/);
  });
});
