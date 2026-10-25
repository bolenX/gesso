import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocHistory, isConflict, Patch, select, type Doc, type Layer, type Op } from "@gesso/core";
import { cropRendered, defaultAssetLoader, measure, renderArtboard, sampleAt, type Rendered } from "@gesso/render";
import { describe, expect, it } from "vitest";
import { preflight } from "../src/preflight.js";
import { instantiate } from "../src/recipes.js";
import { loadSkills, skillsRoot } from "../src/skills.js";
import { FIXTURES, H, W } from "./fixtures/photos.js";

// Every skill's examples (skills/<name>/examples/*.json) run here: a fixture document, the recipe
// steps applied as patches, and checks on the before and after renders. A skill ships only when
// its examples pass, and every recipe needs at least one example.

type Region = [number, number, number, number];
type Check = {
  what: string;
  /** A Stats field, e.g. "noise", "luminance.mean", "color.lab.2" (b*), "luminance.clipped.highlights". */
  metric?: string;
  region?: Region;
  /** Measure only these layers. */
  layers?: string[];
  /** after ≤ before × less; after ≥ before × more; after ≤ max; after ≥ min; |after − before| ≤ keep. */
  less?: number;
  more?: number;
  max?: number;
  min?: number;
  keep?: number;
  /** Colour at a point: ΔE between before and after must be within the bounds. */
  sample?: [number, number];
  size?: number;
  deltaE?: { min?: number; max?: number };
  /** Layout problems after the steps, as canvas_inspect's preflight reports them. */
  preflight?: { maxErrors?: number; maxWarnings?: number };
  /** A field of the layer `target` matches after the steps: { target: "#id", path: "style.fill", equals: … }. */
  field?: { target: string; path: string; equals: unknown };
  /** How many layers match a selector after the steps. */
  count?: { selector: string; equals: number };
};
/** `setup` steps build the scene (a stand-in subject, say) and count as part of "before". */
type Step = { skill?: string; recipe?: string; params?: Record<string, unknown>; ops?: Op[]; setup?: boolean };
/** `before`: the layers visible in the "before" render, when it isn't the whole starting document (two exposures stacked, say). */
type Example = { description: string; layers?: string[]; before?: string[]; doc?: Doc; steps: Step[]; checks: Check[] };

const skills = loadSkills(skillsRoot());

const get = (stats: unknown, path: string): number => {
  let v: unknown = stats;
  for (const key of path.split(".")) v = (v as Record<string, unknown>)?.[key];
  if (typeof v !== "number") throw new Error(`No number at "${path}"`);
  return v;
};

async function fixtureDoc(names: string[], dir: string): Promise<Doc> {
  const doc: Doc = { id: "example", revision: 0, assets: {}, artboards: [{ id: "a", name: "A", frame: { x: 0, y: 0, w: W, h: H }, layers: [] }] };
  for (const name of names) {
    const make = FIXTURES[name];
    if (!make) throw new Error(`No fixture "${name}". Fixtures: ${Object.keys(FIXTURES).join(", ")}`);
    await writeFile(join(dir, `${name}.png`), await make());
    doc.assets[name] = { uri: `${name}.png`, kind: "image", width: W, height: H };
    doc.artboards[0]!.layers.push({ id: name, name, type: "image", asset: name, fit: "fill", frame: { x: 0, y: 0, w: W, h: H } } as Layer);
  }
  return doc;
}

function only(doc: Doc, ids: string[]): Doc {
  const keep = new Set(ids);
  const hide = (layers: Layer[]): Layer[] =>
    layers.map((l) => (keep.has(l.id) ? l : l.type === "group" ? ({ ...l, children: hide(l.children) } as Layer) : ({ ...l, visible: false } as Layer)));
  return { ...doc, artboards: doc.artboards.map((a) => ({ ...a, background: undefined, layers: hide(a.layers) })) } as Doc;
}

const examples: Array<{ skill: string; file: string; example: Example }> = [];
for (const skill of skills) {
  const dir = join(skill.dir, "examples");
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) examples.push({ skill: skill.name, file, example: JSON.parse(readFileSync(join(dir, file), "utf8")) });
}

describe("skills", () => {
  it("each has a description and checks, and every recipe has an example", () => {
    const missing: string[] = [];
    for (const skill of skills) {
      if (!skill.description) missing.push(`${skill.name}: no description`);
      if (!skill.checks) missing.push(`${skill.name}: no checks.md`);
      for (const recipe of Object.keys(skill.recipes?.recipes ?? {})) {
        const used = examples.some((e) => e.example.steps.some((s) => s.recipe === recipe && (s.skill ?? e.skill) === skill.name));
        if (!used) missing.push(`${skill.name}: recipe "${recipe}" has no example`);
      }
    }
    expect(missing).toEqual([]);
  });

  for (const { skill: skillName, file, example } of examples) {
    it(`${skillName} / ${file}: ${example.description}`, { timeout: 120_000 }, async () => {
      const dir = await mkdtemp(join(tmpdir(), "gesso-skill-"));
      const loader = defaultAssetLoader(dir);
      const start = example.doc ? structuredClone(example.doc) : await fixtureDoc(example.layers ?? [], dir);
      if (example.doc) {
        // Inline documents name fixtures as their image assets' uri ("fixture:portrait").
        for (const asset of Object.values(start.assets)) {
          const name = asset.uri.replace(/^fixture:/, "");
          if (asset.uri.startsWith("fixture:")) {
            await writeFile(join(dir, `${name}.png`), await FIXTURES[name]!());
            asset.uri = `${name}.png`;
          }
        }
      }
      const history = new DocHistory(start, "test");
      let before = start;
      for (const step of example.steps) {
        let ops = step.ops;
        if (step.recipe) {
          const owner = skills.find((s) => s.name === (step.skill ?? skillName));
          const recipe = owner?.recipes?.recipes[step.recipe];
          if (!recipe) throw new Error(`No recipe "${step.recipe}" in ${step.skill ?? skillName}`);
          ops = instantiate(recipe, step.params ?? {}, history.head);
        }
        const result = history.apply(Patch.parse({ doc: start.id, baseRevision: history.head.revision, ops }), "test");
        if (isConflict(result)) throw new Error("conflict");
        if (step.setup) before = history.head;
      }
      const after = history.head;
      const artboard = after.artboards[0]!.id;
      const renders = new Map<string, Promise<Rendered>>();
      const render = (d: Doc, which: string, layers?: string[]) => {
        const key = `${which}:${layers?.join(",") ?? ""}`;
        if (!renders.has(key)) renders.set(key, renderArtboard(layers ? only(d, layers) : d, artboard, { loader }));
        return renders.get(key)!;
      };
      const failures: string[] = [];
      for (const check of example.checks) {
        if (check.field) {
          const layer = select(after, check.field.target)[0]?.layer as Record<string, unknown> | undefined;
          const value = check.field.path.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], layer);
          if (JSON.stringify(value) !== JSON.stringify(check.field.equals)) failures.push(`${check.what}: ${check.field.target} ${check.field.path} is ${JSON.stringify(value)}`);
          continue;
        }
        if (check.count) {
          const n = select(after, check.count.selector).length;
          if (n !== check.count.equals) failures.push(`${check.what}: ${n} layers match ${check.count.selector}`);
          continue;
        }
        if (check.preflight) {
          const issues = await preflight(after, artboard);
          const errors = issues.filter((i) => i.severity === "error").length;
          const warnings = issues.filter((i) => i.severity === "warning").length;
          if (errors > (check.preflight.maxErrors ?? 0) || warnings > (check.preflight.maxWarnings ?? Infinity)) failures.push(`${check.what}: ${JSON.stringify(issues)}`);
          continue;
        }
        const [b, a] = await Promise.all([render(before, "before", check.layers ?? example.before), render(after, "after", check.layers)]);
        if (check.sample) {
          const [s0, s1] = [sampleAt(b, check.sample, check.size ?? 5), sampleAt(a, check.sample, check.size ?? 5)];
          const e = Math.hypot(s0.lab[0] - s1.lab[0], s0.lab[1] - s1.lab[1], s0.lab[2] - s1.lab[2]);
          if ((check.deltaE?.max !== undefined && e > check.deltaE.max) || (check.deltaE?.min !== undefined && e < check.deltaE.min)) {
            failures.push(`${check.what}: ΔE ${e.toFixed(1)} at ${check.sample.join(",")} (${s0.hex} → ${s1.hex})`);
          }
          continue;
        }
        const region = check.region ? { x: check.region[0], y: check.region[1], w: check.region[2], h: check.region[3] } : undefined;
        const [mb, ma] = [measure(region ? cropRendered(b, region) : b), measure(region ? cropRendered(a, region) : a)];
        const [vb, va] = [get(mb, check.metric!), get(ma, check.metric!)];
        const ok =
          (check.less === undefined || va <= vb * check.less) &&
          (check.more === undefined || va >= vb * check.more) &&
          (check.max === undefined || va <= check.max) &&
          (check.min === undefined || va >= check.min) &&
          (check.keep === undefined || Math.abs(va - vb) <= check.keep);
        if (!ok) failures.push(`${check.what}: ${check.metric} ${vb} → ${va}`);
      }
      expect(failures, `${skillName}/${file}`).toEqual([]);
    });
  }
});
