import { describe, expect, it } from "vitest";
import { parseSelector, SelectorError } from "../src/index.js";

describe("parseSelector", () => {
  it.each([
    ["#headline", { term: { kind: "id", value: "headline" } }],
    ["@cta", { term: { kind: "role", value: "cta" } }],
    [".brand", { term: { kind: "tag", value: "brand" } }],
    ["$selection", { term: { kind: "selection" } }],
    ["story-9x16 #headline", { artboard: "story-9x16", term: { kind: "id", value: "headline" } }],
  ])("parses %s", (input, expected) => {
    expect(parseSelector(input)).toEqual(expected);
  });

  it.each(["", "headline", "#", "/layers/3", "a b #c"])("rejects %j", (input) => {
    expect(() => parseSelector(input)).toThrow(SelectorError);
  });
});

describe("select", () => {
  it("resolves ids, roles and scoped selectors", async () => {
    const { select } = await import("../src/index.js");
    const { promo } = await import("./fixtures.js");
    expect(select(promo, "#headline").map((m) => m.layer.id)).toEqual(["headline"]);
    expect(select(promo, "@background").map((m) => m.layer.id)).toEqual(["backdrop"]);
    expect(select(promo, "post-4x5 #card")).toHaveLength(1);
    expect(select(promo, "$selection", ["card", "headline"])).toHaveLength(2);
    expect(() => select(promo, "story-9x16 #headline")).toThrow(SelectorError);
  });
});
