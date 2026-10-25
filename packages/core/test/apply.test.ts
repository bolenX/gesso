import { describe, expect, it } from "vitest";
import { applyOps, DocHistory, isConflict, PatchError, type Doc, type Patch } from "../src/index.js";
import { promo } from "./fixtures.js";

const layerIds = (doc: Doc) => doc.artboards[0]!.layers.map((l) => l.id);
const patch = (ops: Patch["ops"], baseRevision = 12): Patch => ({ doc: "promo-01", baseRevision, ops });

describe("applyOps", () => {
  it("sets values by ID and never mutates the input", () => {
    const { doc, changed } = applyOps(promo, [
      { op: "set", target: "#headline", path: "content", value: "Autumn Edit" },
      { op: "set", target: "#card-photo", path: "opacity", value: 0.8 },
    ]);
    expect(changed).toEqual(["headline", "card-photo"]);
    expect(doc.artboards[0]!.layers[3]).toMatchObject({ content: "Autumn Edit" });
    expect(promo.artboards[0]!.layers[3]).toMatchObject({ content: "Summer Edit" });
  });

  it("sets nested paths and removes a field with null", () => {
    const { doc } = applyOps(promo, [
      { op: "set", target: "#headline", path: "style.fill", value: "#E8572A" },
      { op: "set", target: "#card-photo", path: "blend", value: null },
    ]);
    expect(doc.artboards[0]!.layers[3]).toMatchObject({ style: { fill: "#E8572A" } });
    expect(doc.artboards[0]!.layers[2]).not.toHaveProperty("blend");
  });

  it("appends to, indexes into and removes from lists", () => {
    const { doc } = applyOps(promo, [
      { op: "set", target: "#card-photo", path: "filters.+", value: { kind: "gaussian-blur", radius: 2 } },
      { op: "set", target: "#card-photo", path: "filters.+", value: { kind: "high-pass", radius: 4 } },
      { op: "set", target: "#card-photo", path: "filters.0.radius", value: 6 },
    ]);
    expect(doc.artboards[0]!.layers[2]).toMatchObject({ filters: [{ kind: "gaussian-blur", radius: 6 }, { kind: "high-pass", radius: 4 }] });
    const removed = applyOps(doc, [{ op: "set", target: "#card-photo", path: "filters.0", value: null }]).doc;
    expect(removed.artboards[0]!.layers[2]).toMatchObject({ filters: [{ kind: "high-pass" }] });
    expect(() => applyOps(doc, [{ op: "set", target: "#card-photo", path: "filters.5", value: { kind: "blur" } }])).toThrow(/2 items/);
    expect(() => applyOps(doc, [{ op: "set", target: "#headline", path: "style.+", value: 1 }])).toThrow(/isn't one/);
  });

  it("applies the same set to $selection with many", () => {
    const { changed } = applyOps(
      promo,
      [{ op: "set", target: "$selection", path: "opacity", value: 0.5, many: true }],
      { selection: ["backdrop", "card"] },
    );
    expect(changed).toEqual(["backdrop", "card"]);
  });

  it("rejects multi-layer matches without many", () => {
    const doc = applyOps(promo, [
      { op: "set", target: "#card", path: "meta.role", value: "background" },
    ]).doc;
    expect(() => applyOps(doc, [{ op: "set", target: "@background", path: "opacity", value: 1 }])).toThrow(/many/);
  });

  it("inserts, moves and removes layers", () => {
    const { doc } = applyOps(promo, [
      {
        op: "insert",
        after: "#card-photo",
        layer: { id: "badge", name: "Badge", type: "shape", frame: { anchor: "top-right", margin: 32 }, shape: { kind: "ellipse" } },
      },
      { op: "move", target: "#headline", to: "bottom" },
      { op: "move", target: "#headline", to: { after: "#badge" } },
      { op: "remove", target: "#backdrop" },
    ]);
    expect(layerIds(doc)).toEqual(["card", "card-photo", "badge", "headline"]);
  });

  it("inserts into an artboard by ID", () => {
    const { doc } = applyOps(promo, [
      {
        op: "insert",
        into: "#post-4x5",
        layer: { id: "logo", name: "Logo", type: "shape", frame: { anchor: "top-left" }, shape: { kind: "rect" } },
      },
    ]);
    expect(layerIds(doc).at(-1)).toBe("logo");
  });

  it.each<[string, Patch["ops"], RegExp]>([
    ["missing target", [{ op: "remove", target: "#nope" }], /matches no layers/],
    ["frozen path", [{ op: "set", target: "#card", path: "id", value: "x" }], /cannot be changed/],
    ["invalid value", [{ op: "set", target: "#card", path: "opacity", value: 2 }], /not a valid document/],
    ["duplicate id", [{ op: "insert", after: "#card", layer: { ...promo.artboards[0]!.layers[0]!, id: "headline" } }], /already exists/],
    ["clip with no base", [{ op: "remove", target: "#backdrop" }, { op: "remove", target: "#card" }], /no base layer/],
    ["missing asset", [{ op: "set", target: "#card-photo", path: "asset", value: "ghost" }], /missing asset/],
  ])("rejects %s and leaves the document unchanged", (_, ops, message) => {
    const before = structuredClone(promo);
    expect(() => applyOps(promo, ops)).toThrow(message);
    expect(promo).toEqual(before);
  });

  it("allows the same layer IDs on different artboards and scopes edits", () => {
    const doc = structuredClone(promo);
    doc.artboards.push({ ...structuredClone(doc.artboards[0]!), id: "story-9x16", frame: { x: 1200, y: 0, w: 1080, h: 1920 } });
    expect(() => applyOps(doc, [{ op: "remove", target: "#headline" }])).toThrow(/many/);
    const { doc: next } = applyOps(doc, [
      { op: "set", target: "story-9x16 #headline", path: "content", value: "Story" },
      { op: "move", target: "story-9x16 #headline", to: "bottom" },
      { op: "remove", target: "story-9x16 #backdrop" },
    ]);
    expect(layerIds(next)).toEqual(["backdrop", "card", "card-photo", "headline"]);
    expect(next.artboards[1]!.layers.map((l) => l.id)).toEqual(["headline", "card", "card-photo"]);
  });

  it("is atomic: a later failing op discards earlier ones", () => {
    expect(() =>
      applyOps(promo, [
        { op: "set", target: "#headline", path: "content", value: "Changed" },
        { op: "remove", target: "#nope" },
      ]),
    ).toThrow(PatchError);
  });

  it("refuses edits to locked layers but allows unlocking", () => {
    const locked = applyOps(promo, [{ op: "set", target: "#card", path: "meta.locked", value: true }]).doc;
    expect(() => applyOps(locked, [{ op: "set", target: "#card", path: "opacity", value: 0.5 }])).toThrow(/locked/);
    expect(() => applyOps(locked, [{ op: "set", target: "#card", path: "meta.locked", value: false }])).not.toThrow();
  });
});

describe("DocHistory", () => {
  it("bumps the revision and records the author", () => {
    const history = new DocHistory(promo);
    const result = history.apply(patch([{ op: "set", target: "#headline", path: "content", value: "A" }]), "agent");
    expect(result).toMatchObject({ revision: 13, changed: ["headline"] });
    expect(history.head.revision).toBe(13);
    expect(history.revisions().at(-1)).toMatchObject({ revision: 13, author: "agent" });
  });

  it("does not commit a dry run", () => {
    const history = new DocHistory(promo);
    const result = history.apply({ ...patch([{ op: "remove", target: "#headline" }]), dryRun: true }, "agent");
    expect(result).toMatchObject({ revision: 12, changed: ["headline"] });
    expect(history.head).toBe(promo);
  });

  it("returns the ops since a stale baseRevision", () => {
    const history = new DocHistory(promo);
    const op = { op: "set", target: "#headline", path: "content", value: "A" } as const;
    history.apply(patch([op]), "human");
    const result = history.apply(patch([{ op: "remove", target: "#card-photo" }]), "agent");
    expect(isConflict(result) && result).toEqual({ conflict: true, currentRevision: 13, opsSince: [op] });
  });

  it("reverts by adding a new revision", () => {
    const history = new DocHistory(promo);
    history.apply(patch([{ op: "remove", target: "#headline" }]), "agent");
    const reverted = history.revert(12, "agent");
    expect(reverted.revision).toBe(14);
    expect(layerIds(reverted)).toContain("headline");
    expect(history.revisions().map((r) => r.revision)).toEqual([12, 13, 14]);
  });
});

describe("DocHistory persistence", () => {
  it("round-trips through JSON with its revisions", () => {
    const history = new DocHistory(promo);
    history.apply(patch([{ op: "set", target: "#headline", path: "content", value: "A" }]), "agent");
    const restored = DocHistory.fromJSON(JSON.parse(JSON.stringify(history)));
    expect(restored.head.revision).toBe(13);
    expect(restored.revisions().map((r) => r.author)).toEqual(["system", "agent"]);
    expect(restored.at(12).artboards[0]!.layers[3]).toMatchObject({ content: "Summer Edit" });
  });

  it("refuses files that aren't saved Gesso documents", () => {
    expect(() => DocHistory.fromJSON({ hello: 1 })).toThrow(/not a saved Gesso document/);
  });
});

describe("asset op", () => {
  it("adds assets and refuses to remove ones in use", () => {
    const added = applyOps(promo, [{ op: "asset", id: "logo", asset: { uri: "logo.png", kind: "image" } }]);
    expect(added.doc.assets.logo).toEqual({ uri: "logo.png", kind: "image" });
    expect(applyOps(added.doc, [{ op: "asset", id: "logo", asset: null }]).doc.assets.logo).toBeUndefined();
    const used = Object.keys(promo.assets).find((id) => promo.assets[id]!.kind === "image")!;
    expect(() => applyOps(promo, [{ op: "asset", id: used, asset: null }])).toThrow(/missing asset/);
  });
});

describe("text runs", () => {
  it("must add up to the content", () => {
    const head = promo.artboards[0]!.layers.find((l) => l.type === "text")!;
    expect(() => applyOps(promo, [{ op: "set", target: `#${head.id}`, path: "runs", value: [{ text: "nope" }] }])).toThrow(/runs don't add up/);
  });
});

describe("edit ops", () => {
  const doc: Doc = {
    id: "e",
    revision: 0,
    assets: {},
    artboards: [
      {
        id: "a",
        name: "A",
        frame: { x: 0, y: 0, w: 100, h: 100 },
        layers: [
          { id: "t1", name: "t1", type: "text", content: "Spring Sale now", style: { font: "A", size: 10 }, frame: { x: 0, y: 0, w: 50, h: 10 } },
          { id: "t2", name: "t2", type: "text", content: "SPRING deals", runs: [{ text: "SPRING" }, { text: " deals", fill: "#FF0000" }], style: { font: "A", size: 10 }, frame: { x: 0, y: 20, w: 50, h: 10 } },
          { id: "g", name: "Group", type: "group", frame: { x: 0, y: 0, w: 100, h: 100 }, children: [{ id: "dot", name: "dot", type: "shape", shape: { kind: "ellipse" }, fill: "#000000", frame: { x: 10, y: 10, w: 5, h: 5 } }] },
        ] as Doc["artboards"][0]["layers"],
      },
    ],
  };

  it("finds and replaces text, keeping styled runs", () => {
    const { doc: out, changed } = applyOps(doc, [{ op: "replace-text", find: "spring", replace: "Summer", matchCase: false }]);
    const [t1, t2] = out.artboards[0]!.layers as Array<Extract<Doc["artboards"][0]["layers"][0], { type: "text" }>>;
    expect(changed.sort()).toEqual(["t1", "t2"]);
    expect(t1!.content).toBe("Summer Sale now");
    expect(t2!.runs).toEqual([{ text: "Summer" }, { text: " deals", fill: "#FF0000" }]);
    const regex = applyOps(doc, [{ op: "replace-text", target: "#t1", find: "(\\w+) Sale", replace: "$1 Event", regex: true }]).doc;
    expect((regex.artboards[0]!.layers[0] as { content: string }).content).toBe("Spring Event now");
  });

  it("duplicates a group with fresh ids, offset", () => {
    const out = applyOps(doc, [{ op: "duplicate", target: "#g", id: "g2" }]).doc;
    const layers = out.artboards[0]!.layers;
    expect(layers.map((l) => l.id)).toEqual(["t1", "t2", "g", "g2"]);
    expect(layers[3]).toMatchObject({ name: "Group copy", children: [{ id: "g2-dot" }] });
    const moved = applyOps(doc, [{ op: "duplicate", target: "#t1", id: "t1b", offset: [5, 7], before: "#t1" }]).doc;
    expect(moved.artboards[0]!.layers[0]).toMatchObject({ id: "t1b", frame: { x: 5, y: 7 } });
    expect(() => applyOps(doc, [{ op: "duplicate", target: "#t1", id: "t2" }])).toThrow(/already exists/);
  });
});
