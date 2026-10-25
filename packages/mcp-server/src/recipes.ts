import { select, type Doc, type Layer, type Op } from "@gesso/core";

// Recipes: a skill's parameterised patches (skills/<name>/recipe.json). skill_apply fills one in and applies
// it as a single revision, so a proven layer setup (frequency separation, a flambient stack, a duotone) is one call.
//
// Templates are patch ops with placeholders in strings:
//   "{{name}}"                  a parameter; alone in a string it keeps its type (number, array, object)
//   "{{name.frame}}"            a field of a layer or artboard parameter (layers: the layer; artboards: its frame)
//   "{{= expr}}"                arithmetic on numbers: + - * / ( ), min(), max(), round(); names as above
//   "id-{{name}}"               mixed with text: always a string
// "forEach": "<selector>" on an op repeats it for every matching layer, with {{each}} bound to that layer.
// "repeat": n (or "{{param}}") repeats it n times, with {{i}} counting from 0.

export type RecipeParam = {
  description: string;
  /** layer: a layer id, read as the layer. artboard: an artboard id, read as its frame (x, y, w, h) and id. */
  type?: "layer" | "artboard" | "number" | "string" | "color" | "boolean" | "json";
  default?: unknown;
};

export type Recipe = { description: string; params: Record<string, RecipeParam>; ops: Array<Record<string, unknown>> };

export type RecipeFile = { recipes: Record<string, Recipe> };

/** Checks a recipe file's shape, so a broken skill fails its test rather than an agent's call. */
export function parseRecipes(raw: unknown, skill: string): RecipeFile {
  const file = raw as RecipeFile;
  if (!file || typeof file !== "object" || !file.recipes || typeof file.recipes !== "object") throw new Error(`${skill}/recipe.json needs a "recipes" object`);
  for (const [name, recipe] of Object.entries(file.recipes)) {
    if (typeof recipe.description !== "string" || !recipe.params || !Array.isArray(recipe.ops) || !recipe.ops.length) {
      throw new Error(`${skill}/recipe.json: recipe "${name}" needs a description, params and ops`);
    }
  }
  return file;
}

/** A one-line summary of each recipe and its parameters, for skill_read. */
export function describeRecipes(file: RecipeFile): string {
  return Object.entries(file.recipes)
    .map(([name, r]) => {
      const params = Object.entries(r.params).map(([p, d]) => `  - \`${p}\`${d.type ? ` (${d.type})` : ""}${d.default !== undefined ? `, default ${JSON.stringify(d.default)}` : ""}: ${d.description}`);
      return `- **${name}**: ${r.description}\n${params.join("\n")}`;
    })
    .join("\n");
}

type Scope = Record<string, unknown>;

/** Fills in a recipe for a document: parameters checked and resolved, placeholders replaced, forEach expanded. */
export function instantiate(recipe: Recipe, given: Record<string, unknown>, doc: Doc): Op[] {
  const scope: Scope = {};
  for (const [name, param] of Object.entries(recipe.params)) {
    const value = given[name] ?? param.default;
    if (value === undefined) throw new Error(`Recipe parameter "${name}" is required: ${param.description}`);
    scope[name] = resolveParam(name, param, value, doc);
  }
  for (const name of Object.keys(given)) if (!(name in recipe.params)) throw new Error(`Unknown recipe parameter "${name}". Parameters: ${Object.keys(recipe.params).join(", ")}`);
  const ops: Op[] = [];
  for (const template of recipe.ops) {
    const { forEach, repeat, ...op } = template as { forEach?: string; repeat?: number | string } & Record<string, unknown>;
    if (repeat !== undefined) {
      const n = Number(fill(repeat, scope));
      if (!Number.isInteger(n) || n < 0 || n > 200) throw new Error(`Recipe "repeat" must be a whole number from 0 to 200, not ${String(n)}`);
      for (let i = 0; i < n; i++) ops.push(fill(op, { ...scope, i }) as Op);
    } else if (forEach) {
      const selector = fill(forEach, scope) as string;
      for (const layer of select(doc, selector).map((m) => m.layer).filter((l): l is Layer => !!l)) ops.push(fill(op, { ...scope, each: layer }) as Op);
    } else ops.push(fill(op, scope) as Op);
  }
  return ops;
}

function resolveParam(name: string, param: RecipeParam, value: unknown, doc: Doc): unknown {
  switch (param.type) {
    case "layer": {
      const layer = findLayer(doc, String(value));
      if (!layer) throw new Error(`Recipe parameter "${name}": no layer "${String(value)}"`);
      return layer;
    }
    case "artboard": {
      const artboard = doc.artboards.find((a) => a.id === value);
      if (!artboard) throw new Error(`Recipe parameter "${name}": no artboard "${String(value)}". Artboards: ${doc.artboards.map((a) => a.id).join(", ")}`);
      return { id: artboard.id, x: 0, y: 0, w: artboard.frame.w, h: artboard.frame.h, frame: { x: 0, y: 0, w: artboard.frame.w, h: artboard.frame.h } };
    }
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Recipe parameter "${name}" should be a number`);
      return value;
    case "color":
      if (typeof value !== "string" || !/^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error(`Recipe parameter "${name}" should be a colour like #RRGGBB`);
      return value;
    default:
      return value;
  }
}

function findLayer(doc: Doc, id: string): Layer | undefined {
  const walk = (layers: Layer[]): Layer | undefined => {
    for (const l of layers) {
      if (l.id === id) return l;
      if (l.type === "group") {
        const found = walk(l.children);
        if (found) return found;
      }
    }
    return undefined;
  };
  for (const a of doc.artboards) {
    const found = walk(a.layers);
    if (found) return found;
  }
  return undefined;
}

const WHOLE = /^\{\{\s*(=?)\s*([^}]+?)\s*\}\}$/;
const PART = /\{\{\s*(=?)\s*([^}]+?)\s*\}\}/g;

function fill(value: unknown, scope: Scope): unknown {
  if (typeof value === "string") {
    const whole = WHOLE.exec(value);
    if (whole) return whole[1] ? evaluate(whole[2]!, scope) : lookup(whole[2]!, scope);
    return value.replace(PART, (_, isExpr: string, body: string) => {
      const v = isExpr ? evaluate(body, scope) : lookup(body, scope);
      return typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, scope)]));
  return value;
}

/** A dotted path into the scope; a layer or artboard on its own stands for its id. */
function lookup(path: string, scope: Scope): unknown {
  const [head, ...rest] = path.split(".");
  if (!(head! in scope)) throw new Error(`Recipe uses "{{${path}}}" but has no parameter "${head}"`);
  let v: unknown = scope[head!];
  for (const key of rest) {
    if (v === null || typeof v !== "object" || !(key in (v as object))) throw new Error(`Recipe placeholder "{{${path}}}": no "${key}"`);
    v = (v as Record<string, unknown>)[key];
  }
  if (!rest.length && v && typeof v === "object" && "id" in v && !Array.isArray(v)) return (v as { id: unknown }).id;
  return v;
}

/** Arithmetic for "{{= …}}": numbers, names, + - * / and parentheses, min, max, round, abs. No other code runs. */
function evaluate(source: string, scope: Scope): number {
  const tokens = source.match(/\d+(?:\.\d+)?|[A-Za-z_][\w.]*|[-+*/(),]/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const fns: Record<string, (...a: number[]) => number> = { min: Math.min, max: Math.max, round: Math.round, abs: Math.abs, floor: Math.floor, ceil: Math.ceil };
  const primary = (): number => {
    const t = next();
    if (t === undefined) throw new Error(`Recipe expression "${source}" ends too early`);
    if (t === "(") {
      const v = sum();
      if (next() !== ")") throw new Error(`Recipe expression "${source}": missing )`);
      return v;
    }
    if (t === "-") return -primary();
    if (/^\d/.test(t)) return Number(t);
    if (t in fns && peek() === "(") {
      next();
      const args = [sum()];
      while (peek() === ",") {
        next();
        args.push(sum());
      }
      if (next() !== ")") throw new Error(`Recipe expression "${source}": missing )`);
      return fns[t]!(...args);
    }
    const v = lookup(t, scope);
    if (typeof v !== "number") throw new Error(`Recipe expression "${source}": "${t}" isn't a number`);
    return v;
  };
  const product = (): number => {
    let v = primary();
    while (peek() === "*" || peek() === "/") v = next() === "*" ? v * primary() : v / primary();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (peek() === "+" || peek() === "-") v = next() === "+" ? v + product() : v - product();
    return v;
  };
  const result = sum();
  if (i < tokens.length) throw new Error(`Recipe expression "${source}": unexpected "${tokens[i]}"`);
  return Math.round(result * 1000) / 1000;
}
