import { describe, expect, it } from "vitest";
import { project, rectToQuad } from "../src/index.js";

describe("rectToQuad", () => {
  it("maps each rectangle corner onto the quad", () => {
    const quad: [number, number][] = [[12, 30], [410, 5], [380, 260], [40, 300]];
    const m = rectToQuad(200, 100, quad as never);
    const corners: [number, number][] = [[0, 0], [200, 0], [200, 100], [0, 100]];
    corners.forEach((c, i) => {
      const [x, y] = project(m, c);
      expect(x).toBeCloseTo(quad[i]![0], 6);
      expect(y).toBeCloseTo(quad[i]![1], 6);
    });
  });

  it("rejects a degenerate quad", () => {
    expect(() => rectToQuad(10, 10, [[0, 0], [5, 0], [10, 0], [15, 0]])).toThrow(/degenerate/);
  });
});
