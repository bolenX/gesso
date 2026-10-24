import { describe, expect, it } from "vitest";
import { Doc, docIssues, layerIssues, normalizeDoc } from "../src/index.js";

describe("normalizeDoc", () => {
  it("fills obvious defaults and accepts artboard width/height", () => {
    const doc = normalizeDoc({
      id: "d",
      artboards: [{ id: "a", width: 100, height: 50, layers: [{ id: "box", type: "shape", shape: { kind: "rect" }, frame: { x: 0, y: 0, w: 10, h: 10 } }] }],
    });
    expect(Doc.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({ revision: 0, assets: {}, artboards: [{ name: "a", frame: { x: 0, y: 0, w: 100, h: 50 }, layers: [{ name: "box" }] }] });
  });

  it("parses a document sent as a JSON string", () => {
    expect(normalizeDoc('{"id":"d","artboards":[]}')).toMatchObject({ id: "d", revision: 0 });
  });
});

describe("docIssues", () => {
  it("explains an empty document in one line per field", () => {
    expect(docIssues(normalizeDoc({}))).toEqual(["doc.id: required (string)", "doc.artboards: required, a list of artboards"]);
  });

  it("names each layer and its fix instead of dumping the union", () => {
    // The document an agent sent when it had no format to go on.
    const input = normalizeDoc({
      id: "meat",
      revision: 0,
      assets: {},
      artboards: [
        {
          id: "ab",
          name: "Meat",
          width: 2000,
          height: 1942,
          background: "#ffffff",
          layers: [
            { id: "t", type: "text", text: "x" },
            { id: "v", type: "vector", path: "M0 0 L10 10 Z" },
            { id: "s", type: "shape" },
          ],
        },
      ],
    });
    const issues = docIssues(input);
    expect(issues).toEqual([
      expect.stringMatching(/^artboards\[0\] "ab"\.layers\[0\] "t" \(text\)\.frame: needs \{ "x", "y", "w", "h" \}/),
      'artboards[0] "ab".layers[0] "t" (text).content: required (string)',
      expect.stringMatching(/^artboards\[0\] "ab"\.layers\[0\] "t" \(text\)\.style: needs \{ "font"/),
      'artboards[0] "ab".layers[1] "v": type "vector" is not a layer type; use one of image, shape, text, adjustment, group, smart',
      expect.stringMatching(/^artboards\[0\] "ab"\.layers\[2\] "s" \(shape\)\.frame: needs/),
      expect.stringMatching(/^artboards\[0\] "ab"\.layers\[2\] "s" \(shape\)\.shape: needs \{ "kind": "rect"/),
    ]);
    expect(issues.join("\n").length).toBeLessThan(1200);
  });

  it("checks group children against their own types", () => {
    const issues = layerIssues({ id: "g", name: "g", type: "group", frame: { x: 0, y: 0, w: 1, h: 1 }, children: [{ id: "c", name: "c", type: "text" }] });
    expect(issues.some((i) => i.startsWith('layer "g".children[0] "c" (text).content'))).toBe(true);
  });
});
