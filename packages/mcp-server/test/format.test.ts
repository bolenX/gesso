import { Doc, normalizeDoc, semanticErrors } from "@gesso/core";
import { expect, it } from "vitest";
import { DOC_FORMAT } from "../src/format.js";

it("the example in canvas_create's description is a valid document", () => {
  const start = DOC_FORMAT.indexOf("{\n");
  const end = DOC_FORMAT.indexOf("\n}\n", start) + 2;
  const example = DOC_FORMAT.slice(start, end).replace(/\s\/\/[^\n]*/g, "");
  const doc = Doc.parse(normalizeDoc(JSON.parse(example)));
  expect(semanticErrors(doc)).toEqual([]);
  expect(doc.artboards[0]!.layers.map((l) => l.type)).toEqual(["image", "shape", "text"]);
});
