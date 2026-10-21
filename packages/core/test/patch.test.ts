import { describe, expect, it } from "vitest";
import { Patch } from "../src/index.js";

describe("Patch schema", () => {
  it("accepts the spec's example patch", () => {
    const patch = {
      doc: "promo-01",
      baseRevision: 12,
      ops: [
        { op: "set", target: "#headline", path: "content", value: "Autumn Edit" },
        { op: "set", target: "#card-photo", path: "opacity", value: 0.8 },
        { op: "set", target: "$selection", path: "style.fill", value: "#E8572A", many: true },
        { op: "insert", after: "#card-photo", layer: { id: "badge", type: "shape" } },
        { op: "move", target: "#logo", to: "top" },
        { op: "remove", target: "#old-badge" },
      ],
      dryRun: false,
      returnPreview: 0.25,
    };
    const result = Patch.safeParse(patch);
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("rejects index paths and malformed selectors", () => {
    const patch = {
      doc: "promo-01",
      baseRevision: 12,
      ops: [{ op: "remove", target: "/layers/3" }],
    };
    expect(Patch.safeParse(patch).success).toBe(false);
  });

  it("requires exactly one insert position", () => {
    const patch = {
      doc: "promo-01",
      baseRevision: 1,
      ops: [{ op: "insert", layer: { id: "x", type: "shape" } }],
    };
    expect(Patch.safeParse(patch).success).toBe(false);
  });
});
