import { layerIssues, normalizeLayer } from "./explain.js";
import { adjustmentAssets, Doc, filterAssets, type Artboard, type Layer } from "./schema.js";
import { Layer as LayerSchema } from "./schema.js";
import type { Op, Patch } from "./patch.js";
import { select, type Match } from "./select.js";
import { parseSelector } from "./selector.js";

// Applies a patch atomically: every op applies to a copy of the document and
// the copy is validated as a whole, or nothing changes. See docs/spec-v0.1.md,
// "Patch format" and "Rendering pipeline" step 1 (Validate).

export class PatchError extends Error {
  override name = "PatchError";
  constructor(
    message: string,
    /** Index of the failing op, when the failure belongs to one op. */
    readonly opIndex?: number,
  ) {
    super(opIndex === undefined ? message : `op ${opIndex}: ${message}`);
  }
}

export type ApplyOptions = { selection?: string[] };
export type Applied = { doc: Doc; changed: string[]; warnings: string[] };

/** Paths agents may not set: identity is fixed once a layer exists. */
const FROZEN_PATHS = new Set(["id", "type"]);

export function applyOps(doc: Doc, ops: Patch["ops"], options: ApplyOptions = {}): Applied {
  const next = structuredClone(doc);
  const changed = new Set<string>();
  ops.forEach((op, i) => {
    try {
      for (const id of applyOp(next, op, options.selection ?? [])) changed.add(id);
    } catch (err) {
      if (err instanceof PatchError && err.opIndex === undefined) throw new PatchError(err.message, i);
      throw err;
    }
  });

  const parsed = Doc.safeParse(next);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new PatchError(`result is not a valid document at ${issue.path.join(".")}: ${issue.message}`);
  }
  const errors = semanticErrors(parsed.data);
  if (errors.length > 0) throw new PatchError(errors.join("; "));
  return { doc: parsed.data, changed: [...changed], warnings: [] };
}

function applyOp(doc: Doc, op: Op, selection: string[]): string[] {
  switch (op.op) {
    case "set": {
      const matches = resolve(doc, op.target, selection, op.many);
      if (FROZEN_PATHS.has(op.path)) throw new PatchError(`"${op.path}" cannot be changed`);
      for (const { layer } of matches) {
        if (layer.meta?.locked && op.path !== "meta.locked") {
          throw new PatchError(`layer "${layer.id}" is locked`);
        }
        setPath(layer as Record<string, unknown>, op.path, op.value);
      }
      return matches.map((m) => m.layer.id);
    }
    case "remove": {
      const matches = resolve(doc, op.target, selection, op.many);
      for (const { artboard, layer } of matches) {
        assertUnlocked(layer);
        const loc = locate(doc, layer.id, artboard)!;
        loc.siblings.splice(loc.index, 1);
      }
      return matches.map((m) => m.layer.id);
    }
    case "insert": {
      const parsed = LayerSchema.safeParse(normalizeLayer(op.layer));
      if (!parsed.success) throw new PatchError(layerIssues(normalizeLayer(op.layer), "layer").join("; "));
      const layer = parsed.data;
      const { artboard, siblings, index } = insertionPoint(doc, op, selection);
      for (const id of layerIds([layer])) {
        if (locate(doc, id, artboard)) throw new PatchError(`a layer with id "${id}" already exists in "${artboard}"`);
      }
      siblings.splice(index, 0, layer);
      return [layer.id];
    }
    case "artboard": {
      const index = doc.artboards.findIndex((a) => a.id === op.id);
      if (op.artboard) {
        if (op.artboard.id !== op.id) throw new PatchError(`artboard id "${op.artboard.id}" doesn't match op id "${op.id}"`);
        if (index >= 0) doc.artboards[index] = op.artboard;
        else doc.artboards.push(op.artboard);
        return layerIds(op.artboard.layers);
      }
      if (index < 0) throw new PatchError(`there is no artboard "${op.id}" to remove`);
      if (doc.artboards.length === 1) throw new PatchError("a document needs at least one artboard");
      doc.artboards.splice(index, 1);
      return [];
    }
    case "asset": {
      if (op.asset) doc.assets[op.id] = op.asset;
      else if (!(op.id in doc.assets)) throw new PatchError(`there is no asset "${op.id}" to remove`);
      else delete doc.assets[op.id];
      return [];
    }
    case "replace-text": {
      const flags = `g${op.matchCase === false ? "i" : ""}`;
      const pattern = new RegExp(op.regex ? op.find : op.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
      const texts = op.target ? select(doc, op.target, selection).map((m) => m.layer) : allLayers(doc);
      const changedIds: string[] = [];
      for (const layer of texts) {
        if (layer.type !== "text") continue;
        if (layer.runs) {
          const runs = layer.runs.map((run) => ({ ...run, text: run.text.replace(pattern, op.replace) }));
          const content = runs.map((r) => r.text).join("");
          if (content === layer.content) continue;
          assertUnlocked(layer);
          layer.runs = runs.filter((r) => r.text.length > 0);
          layer.content = content;
        } else {
          const content = layer.content.replace(pattern, op.replace);
          if (content === layer.content) continue;
          assertUnlocked(layer);
          layer.content = content;
        }
        changedIds.push(layer.id);
      }
      return changedIds;
    }
    case "duplicate": {
      const [{ artboard, layer }] = resolve(doc, op.target, selection, false) as [Match];
      const copy = structuredClone(layer);
      const rename = (l: Layer, top: boolean) => {
        l.id = top ? op.id : `${op.id}-${l.id}`;
        if (top) l.name = `${layer.name} copy`;
        if (l.type === "group") l.children.forEach((c) => rename(c, false));
      };
      rename(copy, true);
      if (op.offset) {
        if (!("x" in copy.frame)) throw new PatchError(`layer "${layer.id}" is anchored; give the copy its own frame with a set op instead of an offset`);
        copy.frame = { ...copy.frame, x: copy.frame.x + op.offset[0], y: copy.frame.y + op.offset[1] };
      }
      const placement = op.after ?? op.before ?? op.into;
      const { artboard: dest, siblings, index } = placement
        ? insertionPoint(doc, { op: "insert", layer: copy, ...(op.after ? { after: op.after } : op.before ? { before: op.before } : { into: op.into }) } as Extract<Op, { op: "insert" }>, selection)
        : (() => {
            const at = locate(doc, layer.id, artboard)!;
            return { artboard, siblings: at.siblings, index: at.index + 1 };
          })();
      for (const id of layerIds([copy])) {
        if (locate(doc, id, dest)) throw new PatchError(`a layer with id "${id}" already exists in "${dest}"`);
      }
      siblings.splice(index, 0, copy);
      return [copy.id];
    }
    case "move": {
      const [{ artboard, layer }] = resolve(doc, op.target, selection, false) as [Match];
      assertUnlocked(layer);
      const from = locate(doc, layer.id, artboard)!;
      if (typeof op.to === "string") {
        const last = from.siblings.length - 1;
        const to =
          op.to === "top" ? last : op.to === "bottom" ? 0 : op.to === "up" ? Math.min(from.index + 1, last) : Math.max(from.index - 1, 0);
        from.siblings.splice(from.index, 1);
        from.siblings.splice(to, 0, layer);
      } else {
        const ref = "after" in op.to ? op.to.after : op.to.before;
        const [{ artboard: anchorBoard, layer: anchor }] = resolve(doc, ref, selection, false) as [Match];
        if (anchor.id === layer.id) throw new PatchError("cannot move a layer relative to itself");
        if (layer.type === "group" && layerIds(layer.children).includes(anchor.id)) {
          throw new PatchError(`cannot move group "${layer.id}" inside itself`);
        }
        from.siblings.splice(from.index, 1);
        const to = locate(doc, anchor.id, anchorBoard)!;
        to.siblings.splice("after" in op.to ? to.index + 1 : to.index, 0, layer);
      }
      return [layer.id];
    }
  }
}

function resolve(doc: Doc, target: string, selection: string[], many: boolean | undefined): Match[] {
  const matches = select(doc, target, selection);
  if (matches.length === 0) throw new PatchError(`"${target}" matches no layers`);
  if (matches.length > 1 && !many) {
    throw new PatchError(`"${target}" matches ${matches.length} layers; set "many": true to change all of them`);
  }
  return matches;
}

function insertionPoint(doc: Doc, op: Extract<Op, { op: "insert" }>, selection: string[]) {
  if (op.into !== undefined) {
    // "into" accepts an artboard ID as well as a group.
    const { artboard, term } = parseSelector(op.into);
    const board = artboard === undefined && term.kind === "id" ? doc.artboards.find((a) => a.id === term.value) : undefined;
    if (board) return { artboard: board.id, siblings: board.layers, index: board.layers.length };
    const [{ artboard: into, layer }] = resolve(doc, op.into, selection, false) as [Match];
    if (layer.type !== "group") throw new PatchError(`"${op.into}" is not a group or artboard`);
    return { artboard: into, siblings: layer.children, index: layer.children.length };
  }
  const ref = (op.after ?? op.before)!;
  const [{ artboard, layer }] = resolve(doc, ref, selection, false) as [Match];
  const loc = locate(doc, layer.id, artboard)!;
  return { artboard, siblings: loc.siblings, index: op.after !== undefined ? loc.index + 1 : loc.index };
}

function assertUnlocked(layer: Layer): void {
  if (layer.meta?.locked) throw new PatchError(`layer "${layer.id}" is locked`);
}

/**
 * Sets a field by dot path. Arrays take an index ("filters.0.radius") or "+" to append ("filters.+"),
 * so one filter or effect can be added or tuned without rewriting the list. null removes the field or item.
 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const isIndex = (key: string) => key === "+" || /^\d+$/.test(key);
  let node: Record<string, unknown> | unknown[] = target;
  for (const [i, key] of keys.slice(0, -1).entries()) {
    if (Array.isArray(node)) {
      if (!/^\d+$/.test(key) || Number(key) >= node.length) throw new PatchError(`cannot set "${path}": "${key}" is not an item of the list (it has ${node.length})`);
    }
    const parent = node as Record<string, unknown>;
    const child = parent[key];
    if (child === undefined) parent[key] = isIndex(keys[i + 1]!) ? [] : {};
    else if (typeof child !== "object" || child === null) throw new PatchError(`cannot set "${path}": "${key}" is not an object or list`);
    node = parent[key] as Record<string, unknown> | unknown[];
  }
  const last = keys[keys.length - 1]!;
  if (Array.isArray(node)) {
    if (last === "+") {
      if (value !== null) node.push(value);
      return;
    }
    const index = /^\d+$/.test(last) ? Number(last) : NaN;
    if (!(index < node.length)) throw new PatchError(`cannot set "${path}": the list has ${node.length} items; use "+" to append`);
    if (value === null) node.splice(index, 1);
    else node[index] = value;
    return;
  }
  if (last === "+") throw new PatchError(`cannot set "${path}": "+" appends to a list, and "${keys.at(-2) ?? path}" isn't one`);
  if (value === null) delete node[last];
  else node[last] = value;
}

type Location = { artboard: Artboard; siblings: Layer[]; index: number };

/** Finds a layer by ID, optionally within one artboard. IDs are unique per artboard, not per document. */
export function locate(doc: Doc, id: string, artboardId?: string): Location | undefined {
  for (const artboard of doc.artboards) {
    if (artboardId !== undefined && artboard.id !== artboardId) continue;
    const found = locateIn(artboard.layers, id);
    if (found) return { artboard, ...found };
  }
  return undefined;
}

function locateIn(layers: Layer[], id: string): { siblings: Layer[]; index: number } | undefined {
  for (let index = 0; index < layers.length; index++) {
    const layer = layers[index]!;
    if (layer.id === id) return { siblings: layers, index };
    if (layer.type === "group") {
      const found = locateIn(layer.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function layerIds(layers: Layer[]): string[] {
  return layers.flatMap((l) => [l.id, ...(l.type === "group" ? layerIds(l.children) : [])]);
}

/** Semantic checks the schema can't express. */
export function semanticErrors(doc: Doc): string[] {
  const errors: string[] = [];
  let seen = new Set<string>();
  let lumaRefs: Array<[string, string]> = [];
  let imageRefs: Array<[string, string]> = [];
  let images = new Set<string>();
  const checkLayers = (layers: Layer[], where: string) => {
    layers.forEach((layer, i) => {
      if (seen.has(layer.id)) errors.push(`duplicate layer id "${layer.id}" in ${where}`);
      seen.add(layer.id);
      if (layer.type === "image") images.add(layer.id);
      if (layer.clip && (i === 0 || layers.slice(0, i).every((l) => l.clip))) {
        errors.push(`layer "${layer.id}" clips but has no base layer below it in ${where}`);
      }
      if (layer.type === "image" && !(layer.asset in doc.assets)) {
        errors.push(`layer "${layer.id}" uses missing asset "${layer.asset}"`);
      }
      if (layer.mask?.kind === "raster" && !(layer.mask.asset in doc.assets)) {
        errors.push(`mask on "${layer.id}" uses missing asset "${layer.mask.asset}"`);
      }
      if (layer.mask?.kind === "raster" && layer.mask.of) imageRefs.push([layer.id, layer.mask.of]);
      if (layer.type === "adjustment") {
        for (const id of adjustmentAssets(layer.adjustment)) {
          if (!(id in doc.assets)) errors.push(`adjustment "${layer.id}" uses missing LUT asset "${id}"`);
          else if (doc.assets[id]!.kind !== "lut") errors.push(`adjustment "${layer.id}" needs a .cube LUT, but asset "${id}" is a ${doc.assets[id]!.kind}`);
        }
      }
      for (const effect of layer.effects ?? []) {
        if (effect.kind === "pattern-overlay" && !(effect.asset in doc.assets)) errors.push(`pattern overlay on "${layer.id}" uses missing asset "${effect.asset}"`);
      }
      for (const id of (layer.filters ?? []).flatMap(filterAssets)) {
        if (!(id in doc.assets)) errors.push(`a filter on "${layer.id}" uses missing asset "${id}"`);
      }
      if (layer.mask?.kind === "luminance-of") lumaRefs.push([layer.id, layer.mask.layer]);
      if (layer.type === "text" && layer.runs && layer.runs.map((r) => r.text).join("") !== layer.content) {
        errors.push(`text "${layer.id}": its runs don't add up to its content; set content and runs together`);
      }
      if (layer.type === "smart" && !doc.symbols?.[layer.symbol]) {
        errors.push(`layer "${layer.id}" places missing symbol "${layer.symbol}"`);
      }
      if (layer.type === "group") checkLayers(layer.children, `group "${layer.id}"`);
    });
  };
  // Layer IDs are unique within an artboard (or symbol); artboards adapted from one design share them.
  const scopes = [
    ...doc.artboards.map((a) => ({ layers: a.layers, where: `artboard "${a.id}"` })),
    ...Object.values(doc.symbols ?? {}).map((s) => ({ layers: s.layers, where: `symbol "${s.id}"` })),
  ];
  for (const { layers, where } of scopes) {
    seen = new Set();
    lumaRefs = [];
    imageRefs = [];
    images = new Set();
    checkLayers(layers, where);
    for (const [id, ref] of lumaRefs) {
      if (!seen.has(ref)) errors.push(`mask on "${id}" in ${where} refers to missing layer "${ref}"`);
    }
    for (const [id, ref] of imageRefs) {
      if (!images.has(ref)) errors.push(`mask on "${id}" in ${where} follows "${ref}", which isn't an image layer there`);
    }
  }
  return errors;
}

/** Every layer in the document's artboards and symbols, groups included. */
function allLayers(doc: Doc): Layer[] {
  const out: Layer[] = [];
  const visit = (layers: Layer[]) => layers.forEach((l) => (out.push(l), l.type === "group" && visit(l.children)));
  doc.artboards.forEach((a) => visit(a.layers));
  Object.values(doc.symbols ?? {}).forEach((s) => visit(s.layers));
  return out;
}
