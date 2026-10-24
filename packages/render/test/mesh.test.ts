import { describe, expect, it } from "vitest";
import { directionField, gradientTable, meshVertices } from "../src/index.js";

describe("meshVertices", () => {
  it("passes through every control point's position and colour", () => {
    const mesh = {
      kind: "mesh-gradient" as const,
      colors: [
        ["#FF0000", "#00FF00", "#0000FF"],
        ["#FFFFFF", "#000000", "#FFFF00"],
      ],
      points: [
        [[0, 0], [0.4, 0], [1, 0]],
        [[0, 1], [0.6, 1], [1, 1]],
      ] as Array<Array<[number, number]>>,
    };
    const { positions, colors, indices } = meshVertices(mesh, 100, 50);
    const vertex = (x: number, y: number) => {
      for (let n = 0; n < positions.length / 2; n++) {
        if (Math.abs(positions[n * 2]! - x) < 1e-3 && Math.abs(positions[n * 2 + 1]! - y) < 1e-3) return Array.from(colors.slice(n * 4, n * 4 + 3)).map((c) => Math.round(c * 255));
      }
      return undefined;
    };
    expect(vertex(40, 0)).toEqual([0, 255, 0]);
    expect(vertex(60, 50)).toEqual([0, 0, 0]);
    expect(vertex(100, 50)).toEqual([255, 255, 0]);
    expect(indices.length % 3).toBe(0);
    expect(Math.max(...indices)).toBeLessThan(positions.length / 2);
  });
});

describe("gradientTable", () => {
  it("maps brightness along the stops, and reversed", () => {
    const stops = [{ offset: 0, color: "#000000" }, { offset: 0.5, color: "#FF0000" }, { offset: 1, color: "#FFFFFF" }];
    const t = gradientTable(stops);
    expect(Array.from(t.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(t.slice(128 * 3, 128 * 3 + 3))).toEqual([255, 1, 1]);
    expect(Array.from(t.slice(255 * 3))).toEqual([255, 255, 255]);
    expect(Array.from(gradientTable(stops, true).slice(0, 3))).toEqual([255, 255, 255]);
  });
});

describe("directionField", () => {
  it("points along the path's tangent", () => {
    const field = directionField([[0, 10], [40, 10], [40, 50]], 50, 60);
    const at = (x: number, y: number) => Array.from(field.slice((y * 50 + x) * 4, (y * 50 + x) * 4 + 2));
    const [ax, ay] = at(10, 12);
    expect(ax).toBe(255);
    expect(Math.abs(ay! - 128)).toBeLessThanOrEqual(2);
    const [bx, by] = at(42, 45);
    expect(Math.abs(bx! - 128)).toBeLessThanOrEqual(2);
    expect(by).toBe(255);
  });
});
