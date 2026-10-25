import type { Doc, Layer } from "./schema.js";
import { parseSelector, SelectorError, type Selector } from "./selector.js";

export type Match = { artboard: string; layer: Layer };

/** Resolves a selector against a document. `$selection` resolves against the given layer IDs. */
export function select(doc: Doc, selector: string | Selector, selection: string[] = []): Match[] {
  const { artboard, term } = typeof selector === "string" ? parseSelector(selector) : selector;
  if (artboard !== undefined && !doc.artboards.some((a) => a.id === artboard)) {
    throw new SelectorError(`No artboard "${artboard}"`);
  }
  const matches: Match[] = [];
  for (const board of doc.artboards) {
    if (artboard !== undefined && board.id !== artboard) continue;
    for (const layer of walk(board.layers)) {
      const hit =
        term.kind === "id"
          ? layer.id === term.value
          : term.kind === "role"
            ? layer.meta?.role === term.value
            : term.kind === "tag"
              ? (layer.meta?.tags ?? []).includes(term.value)
              : term.kind === "all"
                ? true
                : selection.includes(layer.id);
      if (hit) matches.push({ artboard: board.id, layer });
    }
  }
  return matches;
}

function* walk(layers: Layer[]): Generator<Layer> {
  for (const layer of layers) {
    yield layer;
    if (layer.type === "group") yield* walk(layer.children);
  }
}
