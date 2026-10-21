import { describe, expect, it } from "vitest";
import { Doc, Layer } from "../src/index.js";
import { promo } from "./fixtures.js";

describe("Doc schema", () => {
  it("accepts the spec's promo document", () => {
    expect(Doc.safeParse(promo).success).toBe(true);
  });

  it("accepts nested groups", () => {
    const group = {
      id: "lockup",
      name: "Lockup",
      type: "group",
      isolation: "pass-through",
      frame: { x: 0, y: 0, w: 400, h: 200 },
      children: [
        { id: "logo", name: "Logo", type: "image", asset: "logo", frame: { anchor: "top-left" } },
      ],
    };
    expect(Layer.safeParse(group).success).toBe(true);
  });

  it("rejects index-style IDs with spaces and out-of-range opacity", () => {
    const bad = structuredClone(promo);
    bad.artboards[0]!.layers[0]!.id = "layer 17";
    bad.artboards[0]!.layers[1]!.opacity = 1.5;
    const result = Doc.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects blend modes outside the v0.1 set", () => {
    const bad = structuredClone(promo);
    (bad.artboards[0]!.layers[2] as { blend: string }).blend = "linear-light";
    expect(Doc.safeParse(bad).success).toBe(false);
  });
});
